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
from dataclasses import dataclass

from lxml import etree

from .model import SourceBlock, SourceImage
from .textutil import clean_text, first_sentence  # noqa: F401  (Re-Export)

HEADING_HINTS = ("ueberschrift", "überschrift", "headline", "titel", "title", "head")
KICKER_HINTS = ("dachzeile", "kicker", "rubrik")
SUBTITLE_HINTS = ("unterzeile", "subtitle", "vorspann", "lead", "teaser")
AUTHOR_HINTS = ("autor", "author", "byline", "verfasser")
CAPTION_HINTS = ("bildunterschrift", "caption", "legende", "bildtext")

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
    s = style.lower()
    if any(h in s for h in HEADING_HINTS):
        return "heading"
    if any(h in s for h in KICKER_HINTS):
        return "subheading"
    if any(h in s for h in SUBTITLE_HINTS):
        return "lead"
    if any(h in s for h in CAPTION_HINTS):
        return "caption"
    if any(h in s for h in AUTHOR_HINTS):
        return "other"
    return "paragraph"


def extract_idml_blocks(idml_bytes: bytes) -> list[SourceBlock]:
    """Alle Absaetze aller Stories als Bloecke, in Dateireihenfolge."""
    blocks: list[SourceBlock] = []
    with zipfile.ZipFile(io.BytesIO(idml_bytes)) as zf:
        for name in _safe_members(zf, "Stories/"):
            root = etree.fromstring(zf.read(name))
            # Die Wurzel heisst ebenfalls Story (idPkg), traegt aber kein Self.
            story = next(
                (el for el in root.iter("{*}Story") if el.get("Self")), None
            )
            story_id = story.get("Self") if story is not None else name

            for psr in root.iter("{*}ParagraphStyleRange"):
                style = re.sub(
                    r"^ParagraphStyle/", "", psr.get("AppliedParagraphStyle", "") or ""
                )
                parts: list[str] = []
                for node in psr.iter():
                    # Ein Kommentar oder eine Verarbeitungsanweisung traegt
                    # kein auswertbares Tag; InDesign schreibt beides in die
                    # Stories, und `QName` wirft darueber.
                    if not isinstance(node.tag, str):
                        continue
                    tag = etree.QName(node).localname
                    if tag == "Content" and node.text:
                        parts.append(node.text)
                    elif tag == "Br":
                        parts.append("\n")
                text = clean_text("".join(parts))
                if not text:
                    continue
                blocks.append(
                    SourceBlock(
                        page_index=0,
                        text=text,
                        x0=0.0,
                        y0=0.0,
                        x1=1.0,
                        y1=0.0,
                        kind=_style_kind(style),
                        origin="idml",
                        story_id=story_id,
                        style_name=style or None,
                    )
                )
    return blocks


GRAPHIC_TAGS = ("Image", "EPS", "PDF", "WMF", "ImportedPage")
FRAME_TAGS = ("Rectangle", "Polygon", "Oval", "GraphicLine")


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


def extract_idml_image_frames(idml_bytes: bytes) -> list[IdmlImageFrame]:
    """Bildrahmen mit Geometrie aus den Druckbogen lesen.

    Ein Bildrahmen ist ein Rechteck (oder Polygon/Oval), in dem ein `Image`,
    `EPS`, `PDF` oder eine platzierte Seite steckt. Der Rahmen gibt den
    sichtbaren Ausschnitt vor, nicht das Bild darin — genau die Angabe, die im
    PDF fehlt und dort muehsam ueber Beschnittpfade erraten werden muss.
    """
    frames: list[IdmlImageFrame] = []
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

            rahmen: list[tuple[float, float, float, float, str | None]] = []

            def walk(element, matrix) -> None:
                for kind in element:
                    tag = etree.QName(kind).localname
                    if tag in ("Properties", "TextFrame"):
                        continue
                    eigene = _multiply(matrix, _matrix(kind.get("ItemTransform")))
                    if tag == "Group":
                        walk(kind, eigene)
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
                    rahmen.append((*box, link))

            walk(root.find("{*}Spread") if root.find("{*}Spread") is not None else root,
                 (1.0, 0.0, 0.0, 1.0, 0.0, 0.0))

            for _mitte, seite in seiten:
                breite = seite[2] - seite[0]
                hoehe = seite[3] - seite[1]
                if breite <= 0 or hoehe <= 0:
                    seitenzaehler += 1
                    continue
                for x0, y0, x1, y1, link in rahmen:
                    # Ueber den Mittelpunkt zuordnen: ein angeschnittenes Bild
                    # ragt ueber die Seitenkante hinaus und gehoert trotzdem
                    # zu genau einer Seite.
                    mx, my = (x0 + x1) / 2, (y0 + y1) / 2
                    if not (seite[0] <= mx <= seite[2] and seite[1] <= my <= seite[3]):
                        continue
                    frames.append(
                        IdmlImageFrame(
                            page_number=seitenzaehler,
                            x0=max(0.0, (x0 - seite[0]) / breite),
                            y0=max(0.0, (y0 - seite[1]) / hoehe),
                            x1=min(1.0, (x1 - seite[0]) / breite),
                            y1=min(1.0, (y1 - seite[1]) / hoehe),
                            link=link,
                        )
                    )
                seitenzaehler += 1
    return frames


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
