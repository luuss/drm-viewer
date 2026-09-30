"""IDML (InDesign Markup) auswerten.

Eine Story ist ein durchgehender Text ueber alle verketteten Rahmen hinweg —
das ist das stabilste Signal dafuer, was zusammengehoert. Sie ist aber nicht
automatisch ein ganzer Artikel: Ueberschrift, Vorspann, Haupttext und
Infokasten liegen oft in getrennten Stories.

Deshalb liefert dieses Modul Bloecke mit Story- und Formatangabe, und der
Artikelaufbau entscheidet damit. Die Seitengeometrie kommt weiter aus dem PDF.

Eine binaere .indd-Datei kann hier nicht gelesen werden; dafuer braucht es den
IDML-Export aus InDesign.
"""

from __future__ import annotations

import io
import re
import unicodedata
import urllib.parse
import zipfile
from dataclasses import dataclass, replace

from lxml import etree

from .model import SourceBlock, SourceImage, TableCell, TableData, TocHint
from .textutil import clean_text, first_sentence  # noqa: F401  (Re-Export)

# Die Absatzformate der Hefte sind sprechend benannt ("Ueberschrift 2023",
# "Bildunterschrift DMZ 2023", "Verzeichnis Titel 2023"). Sie sind damit das
# genaueste Signal fuer die Rolle eines Absatzes — genauer als jede Messung an
# Schriftgroessen im PDF. Die Reihenfolge der Pruefung ist entscheidend: viele
# Namen enthalten "ueberschrift", meinen aber etwas anderes.
#
# Von eng nach weit; der erste Treffer gilt.
STYLE_RULES: tuple[tuple[tuple[str, ...], str], ...] = (
    (("bildquelle", "bildnachweis", "fotonachweis"), "other"),
    (("bildunterschrift", "bildtext", "legende", "caption"), "caption"),
    (("verzeichnis", "inhaltsverzeichnis", "inhalt "), "other"),
    (("kolumnentitel", "pagina", "fusszeile", "fußzeile", "kopfzeile"), "other"),
    (("kasten", "infokasten", "box", "klebezettel", "notizzettel"), "box"),
    (("zwischen",), "subheading"),
    (("einleitung", "vorspanntext"), "lead"),
    (("fussnote", "fußnote", "nachsatz", "quellenangabe"), "other"),
    (
        (
            "unterueberschrift",
            "unterüberschrift",
            "unterzeile",
            "untertitel",
            "subtitle",
            "vorspann",
            "lead",
            "teaser",
            "uü ",
            "uu ",
        ),
        "lead",
    ),
    (("autor", "author", "byline", "verfasser"), "other"),
    (("rubrikname", "dachzeile", "kicker", "rubrik"), "subheading"),
    (("zitat", "quote"), "quote"),
    (("ueberschrift", "überschrift", "headline", "titel", "title", "head"), "heading"),
)

# Formate, deren Absaetze Beiwerk sind: sie stehen auf jeder Seite und
# gehoeren zu keinem Artikel. Sie werden gleich beim Lesen verworfen, damit
# sie keine Artikelgrenze vortaeuschen.
BEIWERK_STILE = ("kolumnentitel", "pagina", "fusszeile", "fußzeile", "kopfzeile")


def _ist_beiwerk(style: str) -> bool:
    s = style.lower().replace("_", " ").replace("-", " ")
    return any(h in s for h in BEIWERK_STILE)

MAX_ENTRY_BYTES = 40 * 1024 * 1024


def _safe_members(zf: zipfile.ZipFile, prefix: str) -> list[str]:
    """Nur Eintraege innerhalb des Archivs zulassen (kein Pfad-Ausbruch)."""
    out = []
    for info in zf.infolist():
        name = info.filename
        if not name.startswith(prefix):
            continue
        if name.startswith("/") or ".." in name.split("/"):
            continue
        if info.file_size > MAX_ENTRY_BYTES:
            continue
        out.append(name)
    return sorted(out)


def link_name(uri: str) -> str:
    """Dateiname einer Verknuepfung, vergleichbar gemacht.

    Die IDML nennt den Ort als URI: Leerzeichen stehen als `%20`, und auf einem
    Mac liegen Umlaute zerlegt vor (`a` plus Trema). Beides muss weg, sonst
    findet sich die Datei aus `Links/` nie wieder.
    """
    name = urllib.parse.unquote(uri.rsplit("/", 1)[-1])
    return unicodedata.normalize("NFC", name)


def _style_kind(style: str) -> str:
    """Rolle eines Absatzes aus seinem Absatzformat."""
    s = style.lower().replace("-", " ")
    for hinweise, rolle in STYLE_RULES:
        if any(h in s for h in hinweise):
            return rolle
    return "paragraph"


def _kette_ordnen(rahmen: list["IdmlTextFrame"]) -> list["IdmlTextFrame"]:
    """Die Rahmen einer Story in Lesereihenfolge bringen.

    Der Satz verkettet die Rahmen (`PreviousTextFrame`, `NextTextFrame`); die
    Kette ist die einzige verlaessliche Reihenfolge, denn ein Fortsetzungsrahmen
    kann weiter vorn im Heft stehen. Wo die Kette reisst, entscheidet die Lage
    auf der Seite.
    """
    nach_id = {f.self_id: f for f in rahmen if f.self_id}
    vorhanden = set(nach_id)
    start = [
        f for f in rahmen if not f.previous or f.previous not in vorhanden
    ]
    start.sort(key=lambda f: (f.page_number, f.y0, f.x0))
    geordnet: list[IdmlTextFrame] = []
    gesehen: set[str] = set()
    for anfang in start:
        aktuell: IdmlTextFrame | None = anfang
        while aktuell is not None and aktuell.self_id not in gesehen:
            geordnet.append(aktuell)
            gesehen.add(aktuell.self_id)
            aktuell = nach_id.get(aktuell.next) if aktuell.next else None
    # Was die Kette nicht erreicht hat, kommt nach Lage hinterher.
    rest = [f for f in rahmen if f.self_id not in gesehen]
    rest.sort(key=lambda f: (f.page_number, f.y0, f.x0))
    return geordnet + rest


def _verteile_auf_rahmen(
    absaetze: list[tuple[str, str]],
    rahmen: list["IdmlTextFrame"],
) -> list[tuple[int, float, float, float, float, str, tuple[float, float, float, float] | None]]:
    """Absaetze einer Story auf ihre Rahmen verteilen.

    Wo genau der Text im Satz umbricht, steht in der IDML nicht — das
    entscheidet erst InDesign beim Setzen. Die Rahmenflaeche ist aber ein
    brauchbares Mass dafuer, wie viel Text ein Rahmen aufnimmt. Der erste
    Absatz landet damit sicher im ersten Rahmen, und das ist die Angabe, auf
    die es ankommt: wo ein Artikel beginnt.

    Liefert je Absatz Seite, Rechteck, Rahmenkennung und den ganzen Rahmen.
    """
    if not rahmen:
        return [(0, 0.0, 0.0, 1.0, 0.0, "", None) for _ in absaetze]

    laengen = [max(1, len(text)) for text, _stil in absaetze]
    gesamt = sum(laengen)
    kapazitaeten = [max(f.flaeche, 1e-6) for f in rahmen]
    kapazitaet_gesamt = sum(kapazitaeten)

    # Kumulierte Grenzen der Rahmen, auf 0..1 normiert.
    grenzen: list[tuple[float, float]] = []
    laufend = 0.0
    for k in kapazitaeten:
        anteil = k / kapazitaet_gesamt
        grenzen.append((laufend, laufend + anteil))
        laufend += anteil

    out = []
    verbraucht = 0
    for laenge in laengen:
        mitte = (verbraucht + laenge / 2) / gesamt
        verbraucht += laenge
        index = next(
            (i for i, (a, b) in enumerate(grenzen) if a <= mitte < b),
            len(rahmen) - 1,
        )
        f = rahmen[index]
        a, b = grenzen[index]
        lokal = (mitte - a) / (b - a) if b > a else 0.0
        hoehe = max(0.0, f.y1 - f.y0)
        # Eine schmale Zeile an der errechneten Stelle: sie ordnet die Bloecke
        # innerhalb der Seite, ohne eine Genauigkeit vorzutaeuschen, die der
        # Satz nicht hergibt.
        y = f.y0 + lokal * hoehe
        out.append(
            (
                f.page_number,
                f.x0,
                min(1.0, max(f.y0, y)),
                f.x1,
                min(1.0, max(f.y0, y) + hoehe * (laenge / gesamt)),
                f.self_id,
                (f.x0, f.y0, f.x1, f.y1),
            )
        )
    return out


# --- Tabellen --------------------------------------------------------------
#
# Eine Tabelle steht im Satz mitten im Text: als `<Table>` in einem
# Zeichenbereich des Absatzes, an dem sie verankert ist. Jede Zelle traegt
# eigene Absaetze. Die Tabelle wird deshalb an genau dieser Stelle zu einem
# eigenen Block, und ihre Zellen tauchen nicht mehr als Absaetze auf.

# Farben, die nichts hervorheben: Schwarz, Papierweiss, Passermarken, "keine".
NEUTRALE_FARBEN = {
    "",
    "n",
    "Swatch/None",
    "Color/Black",
    "Color/Paper",
    "Color/Registration",
}
FETT = ("bold", "semibold", "black", "heavy", "fett", "halbfett")


def _lokal(element) -> str:
    return etree.QName(element).localname if isinstance(element.tag, str) else ""


def _in_zelle(element) -> bool:
    return any(_lokal(a) == "Cell" for a in element.iterancestors())


def _absatz_teile(psr) -> list["str | TableData"]:
    """Die Absaetze eines Formatbereichs, Tabellen an ihrer Stelle.

    Liefert rohen Text je Absatz (getrennt an `<Br/>`) und dazwischen die
    Tabellen als `TableData`. Text vor und nach einer Tabelle im selben
    Absatz bleibt je ein eigener Absatz.
    """
    teile: list[str | TableData] = []
    laufend: list[str] = []

    def abschliessen() -> None:
        teile.append("".join(laufend))
        laufend.clear()

    def gehen(element) -> None:
        for node in element:
            # Ein Kommentar oder eine Verarbeitungsanweisung traegt kein
            # auswertbares Tag; InDesign schreibt beides in die Stories.
            tag = _lokal(node)
            if not tag:
                continue
            if tag == "Table":
                tabelle = _tabelle_lesen(node)
                abschliessen()
                if tabelle is not None:
                    teile.append(tabelle)
                continue
            if tag == "Content" and node.text:
                laufend.append(node.text)
            elif tag == "Br":
                abschliessen()
            gehen(node)

    gehen(psr)
    abschliessen()
    return teile


def _zellen_text(cell) -> str:
    """Text einer Zelle; mehrere Absaetze durch Zeilenumbruch getrennt."""
    absaetze: list[str] = []
    for psr in cell.iter("{*}ParagraphStyleRange"):
        # Nur die Absaetze dieser Zelle, nicht die einer Tabelle darin.
        naechste = next(
            (a for a in psr.iterancestors() if _lokal(a) == "Cell"), None
        )
        if naechste is not cell:
            continue
        for teil in _absatz_teile(psr):
            roh = teil.as_text() if isinstance(teil, TableData) else teil
            text = clean_text(roh)
            if text:
                absaetze.append(text)
    return "\n".join(absaetze)


def _schrift(cell) -> list[tuple[str, str]]:
    """Schriftfarbe und Schnitt aller Zeichenbereiche mit Text."""
    out = []
    for csr in cell.iter("{*}CharacterStyleRange"):
        if not any(
            _lokal(c) == "Content" and (c.text or "").strip() for c in csr
        ):
            continue
        out.append((csr.get("FillColor") or "", (csr.get("FontStyle") or "").lower()))
    return out


def _ist_fett(cell) -> bool:
    schrift = _schrift(cell)
    return bool(schrift) and all(any(f in stil for f in FETT) for _farbe, stil in schrift)


def _hervorgehoben(cell) -> bool:
    schrift = _schrift(cell)
    return bool(schrift) and all(
        farbe not in NEUTRALE_FARBEN for farbe, _stil in schrift
    )


def _flaeche(cell) -> str:
    farbe = cell.get("FillColor") or ""
    return "" if farbe in NEUTRALE_FARBEN else farbe


def _sieht_aus_wie_kopf(erste: list, zweite: list) -> bool:
    """Eine Kopfzeile, die der Satz nicht als solche ausweist.

    Viele Setzer legen keine Tabellenkopfzeile an, sondern faerben die erste
    Zeile ein und setzen sie fett. Beides zusammen oder eine Flaeche, die in
    der zweiten Zeile nicht wiederkehrt, macht die erste Zeile zum Kopf.
    """
    if not erste:
        return False
    flaechen = {_flaeche(c) for c in erste}
    eigene_flaeche = "" not in flaechen and flaechen != {_flaeche(c) for c in zweite}
    fett = all(_ist_fett(c) for c in erste)
    return eigene_flaeche or fett


def _tabelle_lesen(table) -> "TableData | None":
    """Eine `<Table>` aus dem Satz in Zeilen und Zellen zerlegen."""
    spalten_breiten: list[float] = []
    for column in table.findall("{*}Column"):
        try:
            spalten_breiten.append(max(0.0, float(column.get("SingleColumnWidth") or 0)))
        except ValueError:
            spalten_breiten.append(0.0)

    zellen: dict[tuple[int, int], object] = {}
    for cell in table.findall("{*}Cell"):
        name = (cell.get("Name") or "").split(":")
        if len(name) != 2:
            continue
        try:
            spalte, zeile = int(name[0]), int(name[1])
        except ValueError:
            continue
        zellen[(zeile, spalte)] = cell
    if not zellen:
        return None

    zeilen_anzahl = max(
        len(table.findall("{*}Row")), max(z for z, _s in zellen) + 1
    )
    spalten_anzahl = max(
        len(spalten_breiten), max(s for _z, s in zellen) + 1
    )

    def spanne(cell, attr: str) -> int:
        try:
            return max(1, int(cell.get(attr) or 1))
        except ValueError:
            return 1

    # Welche Plaetze eine verbundene Zelle schon belegt. InDesign fuehrt die
    # verdeckten Zellen je nach Version mit oder nicht; beides geht.
    belegt: set[tuple[int, int]] = set()
    roh: list[list[tuple[object, int, int]]] = []
    for z in range(zeilen_anzahl):
        zeile: list[tuple[object, int, int]] = []
        for s in range(spalten_anzahl):
            if (z, s) in belegt:
                continue
            cell = zellen.get((z, s))
            if cell is None:
                continue
            rs = min(spanne(cell, "RowSpan"), zeilen_anzahl - z)
            cs = min(spanne(cell, "ColumnSpan"), spalten_anzahl - s)
            for dz in range(rs):
                for ds in range(cs):
                    belegt.add((z + dz, s + ds))
            zeile.append((cell, rs, cs))
        roh.append(zeile)

    kopf = 0
    try:
        kopf = max(0, int(table.get("HeaderRowCount") or 0))
    except ValueError:
        kopf = 0
    if kopf == 0 and len(roh) > 1 and _sieht_aus_wie_kopf(
        [c for c, _rs, _cs in roh[0]], [c for c, _rs, _cs in roh[1]]
    ):
        kopf = 1
    kopf = min(kopf, len(roh))

    zeilen: list[tuple[TableCell, ...]] = []
    for z, zeile in enumerate(roh):
        ist_kopf = z < kopf
        zeilen.append(
            tuple(
                TableCell(
                    text=_zellen_text(cell),
                    header=ist_kopf,
                    row_span=rs,
                    col_span=cs,
                    emphasis=(not ist_kopf) and _hervorgehoben(cell),
                )
                for cell, rs, cs in zeile
            )
        )
    # Eine Tabelle ganz ohne Text ist ein Gestaltungsraster, keine Tabelle.
    if not any(c.text for zeile in zeilen for c in zeile):
        return None

    summe = sum(spalten_breiten)
    breiten = (
        tuple(round(b / summe, 4) for b in spalten_breiten)
        if summe > 0 and len(spalten_breiten) == spalten_anzahl
        else ()
    )
    return TableData(rows=tuple(zeilen), header_rows=kopf, column_widths=breiten)


def extract_idml_blocks(
    idml_bytes: bytes,
    text_frames: list["IdmlTextFrame"] | None = None,
) -> list[SourceBlock]:
    """Alle Absaetze aller Stories als Bloecke.

    Ohne Rahmen bleibt es bei Text und Absatzformat, ohne Ort im Heft. Werden
    die Textrahmen aus `extract_idml_frames` mitgegeben, bekommt jeder Block
    zusaetzlich seine Seite und seine Lage — damit wird der Satz zur
    vollstaendigen Quelle und das PDF nur noch zum Bild der Seite.
    """
    blocks: list[SourceBlock] = []
    rahmen_je_story: dict[str, list[IdmlTextFrame]] = {}
    for f in text_frames or []:
        rahmen_je_story.setdefault(f.story_id, []).append(f)
    for kennung, liste in rahmen_je_story.items():
        rahmen_je_story[kennung] = _kette_ordnen(liste)

    with zipfile.ZipFile(io.BytesIO(idml_bytes)) as zf:
        for name in _safe_members(zf, "Stories/"):
            root = etree.fromstring(zf.read(name))
            # Die Wurzel heisst ebenfalls Story (idPkg), traegt aber kein Self.
            story = next(
                (el for el in root.iter("{*}Story") if el.get("Self")), None
            )
            story_id = story.get("Self") if story is not None else name

            absaetze: list[tuple[str, str]] = []
            # Je Absatz die Tabelle, falls der Absatz eine ist; sonst None.
            tabellen: list[TableData | None] = []
            for psr in root.iter("{*}ParagraphStyleRange"):
                # Die Absaetze in Tabellenzellen gehoeren zur Tabelle. Frueher
                # kamen sie hier ein zweites Mal als einzelne Absaetze heraus.
                if _in_zelle(psr):
                    continue
                style = re.sub(
                    r"^ParagraphStyle/", "", psr.get("AppliedParagraphStyle", "") or ""
                )
                # Ein Formatbereich umfasst oft mehrere Absaetze; getrennt
                # werden sie durch `<Br/>`. Frueher landete der ganze Bereich
                # als ein Block — 150.000 Zeichen Mengentext in fuenf Kloetzen,
                # im Reader eine Wand ohne Absaetze.
                for teil in _absatz_teile(psr):
                    if isinstance(teil, TableData):
                        absaetze.append((teil.as_text(), style))
                        tabellen.append(teil)
                        continue
                    text = clean_text(teil)
                    if not text:
                        continue
                    absaetze.append((text, style))
                    tabellen.append(None)

            if not absaetze:
                continue
            rahmen = rahmen_je_story.get(story_id or "", [])
            if text_frames is not None and not rahmen:
                # Eine Story ohne Rahmen steht nirgends im Heft. Das sind die
                # Vorlagen der Musterseiten — Platzhalter wie "xxx", die
                # Bibliothek der Rubriknamen, aufgehobene Kastentexte. Sie
                # gehoeren nicht in die Ausgabe.
                continue
            lagen = _verteile_auf_rahmen(absaetze, rahmen)
            for (text, style), tabelle, (seite, x0, y0, x1, y1, frame_id, kasten) in zip(
                absaetze, tabellen, lagen
            ):
                if _ist_beiwerk(style):
                    continue
                blocks.append(
                    SourceBlock(
                        page_index=seite,
                        text=text,
                        x0=x0,
                        y0=y0,
                        x1=x1,
                        y1=y1,
                        kind="table" if tabelle is not None else _style_kind(style),
                        table=tabelle,
                        origin="idml",
                        story_id=story_id,
                        frame_id=frame_id or None,
                        style_name=style or None,
                        frame_box=kasten,
                    )
                )
    return blocks


GRAPHIC_TAGS = ("Image", "EPS", "PDF", "WMF", "ImportedPage")
FRAME_TAGS = ("Rectangle", "Polygon", "Oval", "GraphicLine")


@dataclass
class IdmlTextFrame:
    """Ein Textrahmen aus dem Satz, bezogen auf das Netzformat seiner Seite.

    Der Rahmen sagt, wo eine Story auf der Seite steht. Laeuft eine Story ueber
    mehrere Rahmen, haengen diese als Kette aneinander (`previous`, `next`);
    erst die Kette ergibt die Lesereihenfolge ueber Seitengrenzen hinweg.
    """

    page_number: int          # 0-basiert, in der Reihenfolge des Dokuments
    x0: float
    y0: float
    x1: float
    y1: float
    story_id: str
    self_id: str
    previous: str | None = None
    next: str | None = None

    @property
    def flaeche(self) -> float:
        """Grob, wie viel Text hineinpasst — die Rahmenflaeche auf der Seite."""
        return max(0.0, self.x1 - self.x0) * max(0.0, self.y1 - self.y0)


@dataclass
class IdmlImageFrame:
    """Ein Bildrahmen aus dem Satz, bezogen auf das Netzformat seiner Seite.

    Die Koordinaten sind auf die Seite normiert (0..1, y von oben). Wo die
    Seite im PDF liegt, weiss das PDF besser — der Anschnitt kommt dort dazu.
    """

    page_number: int          # 0-basiert, in der Reihenfolge des Dokuments
    x0: float
    y0: float
    x1: float
    y1: float
    link: str | None = None
    # Welcher Teil der verknuepften Datei im Rahmen steht, als Anteile
    # (u0, v0, u1, v1) des Originalbildes. None heisst: ganzes Bild, oder der
    # Satz hat es gedreht bzw. gespiegelt, dann traegt der Seitenausschnitt.
    crop: tuple[float, float, float, float] | None = None


def _matrix(value: str | None) -> tuple[float, float, float, float, float, float]:
    """`ItemTransform` als Matrix (a b c d tx ty); fehlt sie, gilt die Einheit."""
    if not value:
        return (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    teile = value.replace(",", " ").split()
    if len(teile) != 6:
        return (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    try:
        a, b, c, d, tx, ty = (float(t) for t in teile)
    except ValueError:
        return (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    return (a, b, c, d, tx, ty)


def _multiply(outer, inner):
    """Zwei Matrizen verketten: erst `inner`, dann `outer`."""
    a1, b1, c1, d1, e1, f1 = inner
    a2, b2, c2, d2, e2, f2 = outer
    return (
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2,
        e1 * b2 + f1 * d2 + f2,
    )


def _apply(matrix, x: float, y: float) -> tuple[float, float]:
    a, b, c, d, tx, ty = matrix
    return (a * x + c * y + tx, b * x + d * y + ty)


def _path_bounds(element, matrix) -> tuple[float, float, float, float] | None:
    """Umschliessendes Rechteck der Rahmenkontur im Zielsystem.

    InDesign beschreibt jeden Rahmen ueber seine Ankerpunkte, nicht ueber ein
    Rechteck. Ein gedrehter oder freier Rahmen hat deshalb kein
    `GeometricBounds`; die Ankerpunkte hat er immer.
    """
    xs: list[float] = []
    ys: list[float] = []
    for punkt in element.iter("{*}PathPointType"):
        anchor = punkt.get("Anchor")
        if not anchor:
            continue
        teile = anchor.replace(",", " ").split()
        if len(teile) != 2:
            continue
        try:
            x, y = float(teile[0]), float(teile[1])
        except ValueError:
            continue
        px, py = _apply(matrix, x, y)
        xs.append(px)
        ys.append(py)
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def _graphic_crop(
    grafik, matrix, rahmen: tuple[float, float, float, float]
) -> tuple[float, float, float, float] | None:
    """Sichtbarer Anteil des platzierten Bildes, in Anteilen des Originals.

    InDesign legt das Bild in voller Groesse hinter den Rahmen und laesst den
    Rahmen davon zeigen, was er ueberdeckt. `GraphicBounds` nennt die Groesse
    des Bildes, `ItemTransform` seine Lage. Beides zusammen sagt genau, welches
    Stueck der Datei gedruckt wird — ohne Raten am Seitenverhaeltnis.

    Gedrehte oder gespiegelte Bilder geben None zurueck: dort stimmt der
    Ausschnitt aus der gerenderten Seite eher als eine Rechnung, die die
    Drehung ignoriert.
    """
    a, b, c, d, tx, ty = _multiply(matrix, _matrix(grafik.get("ItemTransform")))
    if abs(b) > 1e-6 or abs(c) > 1e-6 or a <= 0 or d <= 0:
        return None
    bounds = next(grafik.iter("{*}GraphicBounds"), None)
    if bounds is None:
        return None
    try:
        links = float(bounds.get("Left"))
        oben = float(bounds.get("Top"))
        rechts = float(bounds.get("Right"))
        unten = float(bounds.get("Bottom"))
    except (TypeError, ValueError):
        return None
    bx0, bx1 = sorted((a * links + tx, a * rechts + tx))
    by0, by1 = sorted((d * oben + ty, d * unten + ty))
    breite, hoehe = bx1 - bx0, by1 - by0
    if breite <= 0 or hoehe <= 0:
        return None
    u0 = max(0.0, min(1.0, (rahmen[0] - bx0) / breite))
    u1 = max(0.0, min(1.0, (rahmen[2] - bx0) / breite))
    v0 = max(0.0, min(1.0, (rahmen[1] - by0) / hoehe))
    v1 = max(0.0, min(1.0, (rahmen[3] - by0) / hoehe))
    if u1 - u0 < 0.05 or v1 - v0 < 0.05:
        return None
    if u0 < 0.005 and v0 < 0.005 and u1 > 0.995 and v1 > 0.995:
        # Der Rahmen zeigt das ganze Bild; kein Schneiden noetig.
        return None
    return (u0, v0, u1, v1)


def _spread_order(zf: zipfile.ZipFile) -> list[str]:
    """Reihenfolge der Druckbogen aus `designmap.xml`.

    Die Dateinamen im Archiv sagen nichts ueber die Reihenfolge. Die Zuordnung
    Seite zu Seitenzahl haengt aber genau daran.
    """
    try:
        root = etree.fromstring(zf.read("designmap.xml"))
    except (KeyError, etree.XMLSyntaxError):
        return _safe_members(zf, "Spreads/")
    namen = []
    for element in root.iter("{*}Spread"):
        src = element.get("src")
        if src and src.startswith("Spreads/") and ".." not in src.split("/"):
            namen.append(src)
    return namen or _safe_members(zf, "Spreads/")


def extract_idml_frames(
    idml_bytes: bytes,
) -> tuple[list[IdmlImageFrame], list[IdmlTextFrame]]:
    """Bild- und Textrahmen mit Geometrie aus den Druckbogen lesen.

    Ein Bildrahmen ist ein Rechteck (oder Polygon/Oval), in dem ein `Image`,
    `EPS`, `PDF` oder eine platzierte Seite steckt. Der Rahmen gibt den
    sichtbaren Ausschnitt vor, nicht das Bild darin — genau die Angabe, die im
    PDF fehlt und dort muehsam ueber Beschnittpfade erraten werden muss.

    Ein Textrahmen traegt die Story, die in ihm steht. Zusammen sagen beide,
    was auf einer Seite wo steht — ohne dass die Seite dafuer gerendert oder
    ihre Textebene geraten werden muss.
    """
    bilder: list[IdmlImageFrame] = []
    texte: list[IdmlTextFrame] = []
    with zipfile.ZipFile(io.BytesIO(idml_bytes)) as zf:
        erlaubt = set(_safe_members(zf, "Spreads/"))
        seitenzaehler = 0
        for name in _spread_order(zf):
            if name not in erlaubt:
                continue
            try:
                root = etree.fromstring(zf.read(name))
            except etree.XMLSyntaxError:
                continue

            # Seiten des Bogens im Bogensystem, von links nach rechts.
            seiten: list[tuple[float, tuple[float, float, float, float]]] = []
            for page in root.iter("{*}Page"):
                bounds = (page.get("GeometricBounds") or "").replace(",", " ").split()
                if len(bounds) != 4:
                    continue
                try:
                    oben, links, unten, rechts = (float(b) for b in bounds)
                except ValueError:
                    continue
                m = _matrix(page.get("ItemTransform"))
                ecken = [
                    _apply(m, links, oben),
                    _apply(m, rechts, oben),
                    _apply(m, links, unten),
                    _apply(m, rechts, unten),
                ]
                xs = [p[0] for p in ecken]
                ys = [p[1] for p in ecken]
                seiten.append(((min(xs) + max(xs)) / 2, (min(xs), min(ys), max(xs), max(ys))))
            seiten.sort(key=lambda s: s[0])

            bildrahmen: list[
                tuple[
                    float,
                    float,
                    float,
                    float,
                    str | None,
                    tuple[float, float, float, float] | None,
                ]
            ] = []
            textrahmen: list[tuple[float, float, float, float, str, str, str | None, str | None]] = []

            def walk(element, matrix) -> None:
                for kind in element:
                    tag = etree.QName(kind).localname
                    if tag == "Properties":
                        continue
                    eigene = _multiply(matrix, _matrix(kind.get("ItemTransform")))
                    if tag == "Group":
                        walk(kind, eigene)
                        continue
                    if tag == "TextFrame":
                        story = kind.get("ParentStory")
                        box = _path_bounds(kind, eigene)
                        if story and box is not None:
                            def _kette(wert: str | None) -> str | None:
                                # InDesign schreibt "n" fuer "kein Rahmen".
                                return wert if wert and wert != "n" else None

                            textrahmen.append(
                                (
                                    *box,
                                    story,
                                    kind.get("Self") or "",
                                    _kette(kind.get("PreviousTextFrame")),
                                    _kette(kind.get("NextTextFrame")),
                                )
                            )
                        continue
                    if tag not in FRAME_TAGS:
                        continue
                    grafik = next(
                        (
                            g
                            for g in kind
                            if etree.QName(g).localname in GRAPHIC_TAGS
                        ),
                        None,
                    )
                    if grafik is None:
                        # Leerer Rahmen oder Farbflaeche: kein Bild.
                        walk(kind, eigene)
                        continue
                    box = _path_bounds(kind, eigene)
                    if box is None:
                        continue
                    link = next(
                        (
                            link_name(l.get("LinkResourceURI") or "")
                            for l in grafik.iter("{*}Link")
                            if l.get("LinkResourceURI")
                        ),
                        None,
                    )
                    bildrahmen.append((*box, link, _graphic_crop(grafik, eigene, box)))

            walk(root.find("{*}Spread") if root.find("{*}Spread") is not None else root,
                 (1.0, 0.0, 0.0, 1.0, 0.0, 0.0))

            for _mitte, seite in seiten:
                breite = seite[2] - seite[0]
                hoehe = seite[3] - seite[1]
                if breite <= 0 or hoehe <= 0:
                    seitenzaehler += 1
                    continue

                def auf_seite(x0: float, y0: float, x1: float, y1: float):
                    """Rahmen auf die Seite normieren, sofern sein Mitte dort liegt.

                    Ein angeschnittenes Bild ragt ueber die Seitenkante hinaus
                    und gehoert trotzdem zu genau einer Seite.
                    """
                    mx, my = (x0 + x1) / 2, (y0 + y1) / 2
                    if not (seite[0] <= mx <= seite[2] and seite[1] <= my <= seite[3]):
                        return None
                    return (
                        max(0.0, (x0 - seite[0]) / breite),
                        max(0.0, (y0 - seite[1]) / hoehe),
                        min(1.0, (x1 - seite[0]) / breite),
                        min(1.0, (y1 - seite[1]) / hoehe),
                    )

                for x0, y0, x1, y1, link, crop in bildrahmen:
                    box = auf_seite(x0, y0, x1, y1)
                    if box is None:
                        continue
                    bilder.append(
                        IdmlImageFrame(
                            page_number=seitenzaehler,
                            x0=box[0],
                            y0=box[1],
                            x1=box[2],
                            y1=box[3],
                            link=link,
                            crop=crop,
                        )
                    )
                for x0, y0, x1, y1, story, self_id, vorher, nachher in textrahmen:
                    box = auf_seite(x0, y0, x1, y1)
                    if box is None:
                        continue
                    texte.append(
                        IdmlTextFrame(
                            page_number=seitenzaehler,
                            x0=box[0],
                            y0=box[1],
                            x1=box[2],
                            y1=box[3],
                            story_id=story,
                            self_id=self_id,
                            previous=vorher,
                            next=nachher,
                        )
                    )
                seitenzaehler += 1
    return bilder, texte


def extract_idml_image_frames(idml_bytes: bytes) -> list[IdmlImageFrame]:
    """Nur die Bildrahmen — siehe `extract_idml_frames`."""
    return extract_idml_frames(idml_bytes)[0]


def frames_to_images(
    frames: list[IdmlImageFrame],
    page_map: list[tuple[int, int]],
    trims: dict[int, tuple[float, float, float, float]],
    min_area: float = 0.008,
) -> list[SourceImage]:
    """IDML-Rahmen auf die gerenderte PDF-Seite umrechnen.

    Der Satz kennt nur das Netzformat. Das PDF hat zusaetzlich den Anschnitt,
    und aus ihm wird spaeter geschnitten. Deshalb wird jeder Rahmen in die
    Trimbox der zugehoerigen PDF-Seite gelegt.
    """
    kanonisch = dict(page_map)
    out: list[SourceImage] = []
    for frame in frames:
        page_index = kanonisch.get(frame.page_number)
        if page_index is None:
            continue
        trim = trims.get(page_index, (0.0, 0.0, 1.0, 1.0))
        tw = trim[2] - trim[0]
        th = trim[3] - trim[1]
        if tw <= 0 or th <= 0:
            continue
        x0 = trim[0] + frame.x0 * tw
        x1 = trim[0] + frame.x1 * tw
        y0 = trim[1] + frame.y0 * th
        y1 = trim[1] + frame.y1 * th
        if (x1 - x0) * (y1 - y0) < min_area:
            continue
        out.append(
            SourceImage(
                page_index=page_index,
                x0=max(0.0, x0),
                y0=max(0.0, y0),
                x1=min(1.0, x1),
                y1=min(1.0, y1),
                link=frame.link,
                crop=frame.crop,
            )
        )
    out.sort(key=lambda i: (i.page_index, round(i.y0, 3), i.x0))
    return out


def story_of_frames(idml_bytes: bytes) -> dict[str, list[str]]:
    """Textrahmen je Story — zeigt die Verkettung ueber Seiten hinweg."""
    mapping: dict[str, list[str]] = {}
    with zipfile.ZipFile(io.BytesIO(idml_bytes)) as zf:
        for name in _safe_members(zf, "Spreads/"):
            root = etree.fromstring(zf.read(name))
            for frame in root.iter("{*}TextFrame"):
                story = frame.get("ParentStory")
                if not story:
                    continue
                mapping.setdefault(story, []).append(frame.get("Self", ""))
    return mapping


def frames_to_blocks(
    blocks: list[SourceBlock],
    page_map: list[tuple[int, int]],
    trims: dict[int, tuple[float, float, float, float]],
) -> list[SourceBlock]:
    """Satz-Bloecke auf die gerenderte PDF-Seite umrechnen.

    Der Satz kennt nur das Netzformat und zaehlt seine Seiten in
    Dokumentreihenfolge. Das PDF hat zusaetzlich den Anschnitt, und der Reader
    arbeitet auf der kanonischen Seitenliste. Beides wird hier zusammengefuehrt,
    damit Text- und Bildbereiche im selben System liegen.

    Bloecke auf Seiten, die zu dieser PDF-Quelle nicht gehoeren, fallen weg.
    """
    kanonisch = dict(page_map)
    out: list[SourceBlock] = []
    for block in blocks:
        page_index = kanonisch.get(block.page_index)
        if page_index is None:
            continue
        trim = trims.get(page_index, (0.0, 0.0, 1.0, 1.0))
        tw = trim[2] - trim[0]
        th = trim[3] - trim[1]
        if tw <= 0 or th <= 0:
            continue
        kasten = block.frame_box
        if kasten is not None:
            kasten = (
                max(0.0, trim[0] + kasten[0] * tw),
                max(0.0, trim[1] + kasten[1] * th),
                min(1.0, trim[0] + kasten[2] * tw),
                min(1.0, trim[1] + kasten[3] * th),
            )
        out.append(
            replace(
                block,
                page_index=page_index,
                x0=max(0.0, trim[0] + block.x0 * tw),
                y0=max(0.0, trim[1] + block.y0 * th),
                x1=min(1.0, trim[0] + block.x1 * tw),
                y1=min(1.0, trim[1] + block.y1 * th),
                frame_box=kasten,
            )
        )
    return out


def idml_reading_order(blocks: list[SourceBlock]) -> list[SourceBlock]:
    """Satz-Bloecke in Lesereihenfolge bringen.

    Innerhalb einer Story steht die Reihenfolge fest — so wurde der Text
    geschrieben, und die Rahmenkette fuehrt ihn ueber Seitengrenzen. Die
    Stories untereinander ordnet ihre Lage: erst die Seite, auf der die Story
    beginnt, dann die Hoehe, dann die Spalte.

    Eine Spaltenerkennung wie beim PDF ist hier weder noetig noch richtig: der
    Satz weiss selbst, was zusammengehoert.
    """
    reihenfolge: dict[str, int] = {}
    anker: dict[str, tuple[int, float, float]] = {}
    for i, b in enumerate(blocks):
        kennung = b.story_id or f"#{i}"
        if kennung not in reihenfolge:
            reihenfolge[kennung] = i
            anker[kennung] = (b.page_index, round(b.y0, 3), round(b.x0, 3))
    return sorted(
        blocks,
        key=lambda b: (
            anker.get(b.story_id or "", (b.page_index, b.y0, b.x0)),
            reihenfolge.get(b.story_id or "", 0),
        ),
    )


# --- Gedrucktes Inhaltsverzeichnis -----------------------------------------

# Ein Verzeichniseintrag beginnt mit der Seitenzahl: "5 Schicksalsschlacht".
VERZEICHNIS_EINTRAG = re.compile(r"^\s*(\d{1,3})\s+(\S.*)$", re.DOTALL)
VERZEICHNIS_STILE = ("verzeichnis", "inhaltsverzeichnis", "inhalt ")
VERZEICHNIS_TITEL = ("titel", "hauptzeile", "überschrift", "ueberschrift")
# "Verzeichnis Untertitel" enthaelt "titel", ist aber die Unterzeile des
# Eintrags darueber und traegt keine eigene Seitenzahl.
VERZEICHNIS_UNTERZEILE = ("untertitel", "unterzeile", "unterüberschrift", "unterueberschrift")


def _verzeichnis_zeile(text: str) -> list[tuple[int, str]]:
    """Eine Zeile des Inhaltsverzeichnisses in ihre Eintraege zerlegen.

    Drei Formen kommen vor, je nach Reihe:

    * Seitenzahl vorn — "5 Schicksalsschlacht"
    * Seitenzahl hinten — "Vergiftete Nachbarschaft 8"
    * mehrere Eintraege in einem Absatz, wie bei den Rubriken —
      "24 Kalenderblatt 35 Nachrichten aus Deutschland"

    Zeilenumbrueche trennen; innerhalb einer Zeile entscheidet die Stellung der
    Zahl.
    """
    out: list[tuple[int, str]] = []
    for zeile in text.splitlines():
        sauber = " ".join(zeile.split())
        if not sauber:
            continue

        # Mehrere Eintraege: jede Zahl, der Text folgt, eroeffnet einen neuen.
        paare = list(re.finditer(r"(?:^|\s)(\d{1,3})\s+(?=\D)", sauber))
        if len(paare) >= 2:
            for i, m in enumerate(paare):
                ende = paare[i + 1].start() if i + 1 < len(paare) else len(sauber)
                label = sauber[m.end() : ende].strip(" .·–—-")
                if label:
                    out.append((int(m.group(1)), label))
            continue

        treffer = re.match(r"^(\d{1,3})\s+(\D.*)$", sauber)
        if treffer:
            label = treffer.group(2).strip(" .·–—-")
            if label:
                out.append((int(treffer.group(1)), label))
            continue

        treffer = re.match(r"^(.+?)\s+(\d{1,3})$", sauber)
        if treffer:
            label = treffer.group(1).strip(" .·–—-")
            if label:
                out.append((int(treffer.group(2)), label))
    return out


def _rubrikname(text: str) -> str:
    return " ".join(text.split())[:100]


def toc_from_idml(
    blocks: list[SourceBlock], printed_offset: int
) -> list[TocHint]:
    """Das gedruckte Inhaltsverzeichnis aus den Satz-Bloecken lesen.

    Im Satz traegt jeder Eintrag sein eigenes Absatzformat ("Verzeichnis Titel",
    "Inhalt Hauptzeile") und beginnt mit der gedruckten Seitenzahl. Das ist
    eindeutig — anders als im PDF, wo die Eintraege nur an Schriftgroessen und
    Abstaenden zu erkennen sind.

    `printed_offset` ist die Differenz zwischen gedruckter Seitenzahl und
    kanonischem Seitenindex: steht auf der ersten Innenseite eine 3 und liegt
    sie an Position 1, ist der Versatz 2.

    Drei Eigenheiten des Satzes:

    * Ein Titel, den der Setzer mit einem Absatzwechsel umbrochen hat, steht
      als zwei Absaetze ("Wahlrechtsentzug" / "statt Strafpsychiatrie 23").
      Die Zeile ohne Zahl gehoert zum Eintrag dahinter.
    * Rubrikzeilen im Verzeichnisformat ("Inhalt Rubrik") sind Ueberschriften
      der folgenden Eintraege — oder, mit Seitenzahl, selbst ein Eintrag
      ("Kalenderblatt Personen 16").
    * Unterzeilen vergroessern die Flaeche und bleiben als Text am Eintrag,
      damit die Zeile auf der Textebene wiederzufinden ist (toc_layout.py).

    Der Rueckgabewert traegt die Klickflaeche des Eintrags — geschaetzt aus der
    Lage des Absatzes im Rahmen; genau wird sie erst mit der Textebene.
    """
    hints: list[TocHint] = []
    offen: TocHint | None = None
    # Titelzeile ohne Seitenzahl: die erste Zeile eines umbrochenen Titels.
    vorsatz: SourceBlock | None = None
    section: str | None = None
    verzeichnis_story: str | None = None

    def abschliessen() -> None:
        nonlocal offen
        if offen is not None:
            hints.append(offen)
            offen = None

    for block in blocks:
        stil = (block.style_name or "").lower()
        im_verzeichnis = any(h in stil for h in VERZEICHNIS_STILE)
        ist_rubrik = "rubrik" in stil
        if not im_verzeichnis:
            abschliessen()
            vorsatz = None
            # Eine Rubrikzeile mitten in der Verzeichnis-Story ("Deutschland",
            # "International") ueberschreibt die folgenden Eintraege.
            if ist_rubrik and verzeichnis_story and block.story_id == verzeichnis_story:
                section = _rubrikname(block.text)
            continue
        verzeichnis_story = block.story_id or verzeichnis_story
        ist_unterzeile = any(h in stil for h in VERZEICHNIS_UNTERZEILE)
        ist_titel = not ist_unterzeile and any(h in stil for h in VERZEICHNIS_TITEL)
        if not (ist_titel or ist_rubrik):
            # Unterzeile eines Eintrags: sie vergroessert die Flaeche und nennt
            # den Text, an dem die Zeile spaeter wiederzufinden ist.
            if offen is not None:
                offen.y1 = max(offen.y1, block.y1)
                offen.x0 = min(offen.x0, block.x0)
                offen.x1 = max(offen.x1, block.x1)
                offen.details = " ".join(
                    t for t in (offen.details, " ".join(block.text.split())) if t
                )
            vorsatz = None
            continue
        eintraege = _verzeichnis_zeile(block.text)
        if not eintraege:
            abschliessen()
            if ist_rubrik:
                section = _rubrikname(block.text)
                vorsatz = None
            else:
                vorsatz = block
            continue
        abschliessen()
        for i, (gedruckt, label) in enumerate(eintraege):
            ziel = gedruckt - printed_offset
            if ziel < 0:
                continue
            x0, y0, x1, y1 = block.x0, block.y0, block.x1, block.y1
            if i == 0 and vorsatz is not None:
                label = f"{' '.join(vorsatz.text.split())} {label}"
                x0, y0 = min(x0, vorsatz.x0), min(y0, vorsatz.y0)
                x1, y1 = max(x1, vorsatz.x1), max(y1, vorsatz.y1)
            eintrag = TocHint(
                label=label[:200],
                page_index=ziel,
                toc_page_index=block.page_index,
                x0=x0,
                y0=y0,
                x1=x1,
                y1=y1,
                # Eine Rubrik mit Seitenzahl ist ihr eigener Eintrag und
                # steht unter keiner anderen.
                section=None if ist_rubrik else section,
                printed=gedruckt,
            )
            # Nur der letzte bleibt offen: eine folgende Unterzeile gehoert zu ihm.
            if offen is not None:
                hints.append(offen)
            offen = eintrag
        if ist_rubrik:
            section = None
        vorsatz = None
    abschliessen()
    hints.sort(key=lambda h: (h.page_index, h.toc_page_index or 0, h.y0))
    return hints
