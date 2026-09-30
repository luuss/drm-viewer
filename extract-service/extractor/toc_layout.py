"""Klickflaechen des gedruckten Inhaltsverzeichnisses auf die Textebene legen.

Der Satz nennt die Eintraege des Verzeichnisses samt Seitenzahl, aber nicht,
wo ihre Zeilen auf der Seite stehen: die Lage eines Absatzes im Rahmen ist
nur nach Zeichenanteil geschaetzt (`_verteile_auf_rahmen`). Im Reader lagen
die Flaechen deshalb irgendwo im Rahmen und nicht auf dem Eintrag.

Die Textebene des Druck-PDF kennt jede Zeile mit ihrem Rechteck. Der Browser
liest sie beim Import mit pdf.js (web/src/admin/textLayer.ts) und laedt sie
als Quelle `text` hoch — auf das Netzformat normiert, also im selben System
wie die gerenderten Seiten und die Satzrahmen. Hier wird jeder Eintrag darin
gesucht: die Titelzeilen, die gedruckte Seitenzahl daneben und die Unterzeile
darunter. Ihre Rechtecke werden die Klickflaeche.

Ohne Textebene (Hefte, die vor ihrer Einfuehrung importiert wurden) bleibt
alles beim Schaetzwert aus dem Satz.
"""

from __future__ import annotations

import json
import unicodedata
from dataclasses import dataclass, replace

from .model import TocHint

# Woerter derselben Zeile stehen dichter beieinander als Spalten: ein
# Abstand ueber diesem Anteil der Seitenbreite trennt zwei Stuecke.
SPALTENLUECKE = 0.025
# Eine Folgezeile beginnt buendig mit der Zeile darueber (Anteil der Breite).
BUENDIG = 0.02
# Zwischen zwei Zeilen desselben Eintrags liegt hoechstens dieser Anteil der
# Zeilenhoehe; zum naechsten Eintrag ist der Abstand groesser.
ZEILENABSTAND = 0.6
# Die Seitenzahl steht neben dem Titel, nicht in der Nachbarspalte.
ZAHLABSTAND = 0.35
# Rand um die gefundenen Zeilen: die Flaeche endet nicht auf dem Buchstaben.
RAND_X = 0.004
RAND_Y = 0.003
MAX_TITELZEILEN = 4
MAX_UNTERZEILEN = 6


@dataclass(frozen=True)
class TextItem:
    """Ein Stueck Text der Textebene; Koordinaten als Anteile der Seite."""

    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    size: float = 0.0

    @property
    def numeric(self) -> bool:
        return self.text.strip().isdigit()


@dataclass
class Segment:
    """Eine Zeile — oder ihr Stueck in einer Spalte."""

    items: list[TextItem]

    @property
    def text(self) -> str:
        return " ".join(i.text.strip() for i in self.items if i.text.strip())

    @property
    def x0(self) -> float:
        return min(i.x0 for i in self.items)

    @property
    def y0(self) -> float:
        return min(i.y0 for i in self.items)

    @property
    def x1(self) -> float:
        return max(i.x1 for i in self.items)

    @property
    def y1(self) -> float:
        return max(i.y1 for i in self.items)

    @property
    def numeric(self) -> bool:
        return self.text.replace(" ", "").isdigit()

    @property
    def zahl(self) -> int | None:
        return int(self.text.replace(" ", "")) if self.numeric else None

    def _textteile(self) -> list[TextItem]:
        return [i for i in self.items if not i.numeric] or self.items

    @property
    def text_x0(self) -> float:
        """Linke Kante des Textes — ohne eine vorangestellte Seitenzahl."""
        return min(i.x0 for i in self._textteile())

    @property
    def text_y1(self) -> float:
        return max(i.y1 for i in self._textteile())

    @property
    def text_height(self) -> float:
        return max(i.y1 - i.y0 for i in self._textteile())


def parse_text_layer(data: bytes) -> dict[int, list[TextItem]]:
    """Die hochgeladene Textebene lesen: Quellseite -> Textstuecke.

    Form: ``{"pages": [{"sourcePageIndex": n, "items": [[text, x0, y0, x1,
    y1, size], ...]}]}``. Unbrauchbare Stuecke werden uebergangen, eine
    unlesbare Datei ist ein ValueError.
    """
    try:
        doc = json.loads(data)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError(f"Textebene unlesbar: {exc}") from exc
    if not isinstance(doc, dict) or not isinstance(doc.get("pages"), list):
        raise ValueError("Textebene ohne Seitenliste")
    out: dict[int, list[TextItem]] = {}
    for page in doc["pages"]:
        if not isinstance(page, dict):
            continue
        try:
            quelle = int(page.get("sourcePageIndex"))
        except (TypeError, ValueError):
            continue
        items: list[TextItem] = []
        for raw in page.get("items") or []:
            try:
                text = str(raw[0])
                x0, y0, x1, y1 = (float(v) for v in raw[1:5])
                size = float(raw[5]) if len(raw) > 5 else 0.0
            except (TypeError, ValueError, IndexError):
                continue
            if not text.strip() or x1 <= x0 or y1 <= y0:
                continue
            items.append(TextItem(text, x0, y0, x1, y1, size))
        out[quelle] = items
    return out


def text_layer_for_pages(
    data: bytes, page_map: list[tuple[int, int]]
) -> dict[int, list[TextItem]]:
    """Die Textebene auf kanonische Leserseiten umschluesseln."""
    je_quelle = parse_text_layer(data)
    return {
        kanonisch: je_quelle[quelle]
        for quelle, kanonisch in page_map
        if quelle in je_quelle
    }


def text_items_from_pdf(
    pdf_bytes: bytes,
    page_map: list[tuple[int, int]],
    halves: dict[int, str] | None = None,
) -> dict[int, list[TextItem]]:
    """Die Textebene aus dem Druck-PDF lesen, wenn der Browser keine hochgeladen hat.

    Dasselbe System wie die Textebene aus pdf.js: Anteile der TrimBox, y von
    oben. Die Woerter sind hier kleiner geschnitten (je Wort statt je
    Schriftlauf); zu Zeilen finden sie ueber `segments_of` genauso zusammen.
    """
    import io

    import pdfplumber

    from .pdf_extract import _extract_words, _words_on_visible_page

    out: dict[int, list[TextItem]] = {}
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for source_index, canonical in sorted(page_map):
            if source_index >= len(pdf.pages):
                continue
            page = pdf.pages[source_index]
            words = [w for w in _extract_words(page) if w.get("upright", True)]
            words, width, height = _words_on_visible_page(
                page, words, (halves or {}).get(canonical)
            )
            if width <= 0 or height <= 0:
                continue
            out[canonical] = [
                TextItem(
                    w["text"],
                    w["x0"] / width,
                    w["top"] / height,
                    w["x1"] / width,
                    w["bottom"] / height,
                    float(w.get("size") or 0),
                )
                for w in words
                if str(w["text"]).strip()
            ]
    return out


def segments_of(items: list[TextItem]) -> list[Segment]:
    """Textstuecke zu Zeilen buendeln und an Spaltenluecken teilen.

    pdf.js liefert je Schriftwechsel ein eigenes Stueck ("von", "Adel");
    zusammen sind sie eine Zeile. Zwei Stuecke gehoeren zusammen, wenn die
    Mitte des einen in der Hoehe des anderen liegt — und umgekehrt.

    Eine freistehende Seitenzahl bleibt ein eigenes Stueck: gross gesetzt
    reicht sie ueber zwei Titelzeilen, und als Zeilenanker zoege sie die
    zweite Zeile zu sich. Zu ihrem Eintrag findet sie spaeter ueber die
    Hoehe (`_zahl_daneben`).
    """
    zeilen: list[list[TextItem]] = []
    zahlen: list[TextItem] = []
    for it in sorted(items, key=lambda i: (i.y0, i.x0)):
        if it.numeric:
            zahlen.append(it)
            continue
        mitte = (it.y0 + it.y1) / 2
        ziel: list[TextItem] | None = None
        for zeile in reversed(zeilen[-8:]):
            anker = zeile[0]
            anker_mitte = (anker.y0 + anker.y1) / 2
            if anker.y0 <= mitte <= anker.y1 and it.y0 <= anker_mitte <= it.y1:
                ziel = zeile
                break
        if ziel is None:
            zeilen.append([it])
        else:
            ziel.append(it)

    out: list[Segment] = []
    for zeile in zeilen:
        stuecke: list[list[TextItem]] = []
        for it in sorted(zeile, key=lambda i: i.x0):
            if stuecke and it.x0 - max(i.x1 for i in stuecke[-1]) <= SPALTENLUECKE:
                stuecke[-1].append(it)
            else:
                stuecke.append([it])
        out.extend(Segment(s) for s in stuecke)
    out.extend(Segment([z]) for z in zahlen)
    out.sort(key=lambda s: (s.y0, s.x0))
    return out


def _norm(text: str) -> str:
    """Vergleichsform: Ligaturen aufgeloest, ohne Satzzeichen und Abstaende.

    So finden sich getrennte Woerter ("Kino-" + "Kriegsdrama"), weiche
    Trennstriche und unterschiedliche Anfuehrungszeichen wieder.
    """
    return "".join(
        ch for ch in unicodedata.normalize("NFKC", text).casefold() if ch.isalnum()
    )


def _ohne_zahl(text: str, zahl: int | None) -> str | None:
    """Den Text ohne die gedruckte Seitenzahl davor oder dahinter."""
    if zahl is None:
        return None
    t = " ".join(text.split())
    z = str(zahl)
    if t == z:
        return ""
    if t.startswith(z + " "):
        return t[len(z) + 1 :]
    if t.endswith(" " + z):
        return t[: -len(z) - 1]
    return None


def _varianten(text: str, zahl: int | None) -> list[str]:
    """Lesarten einer Zeile: erst ohne die Seitenzahl, dann wie gedruckt."""
    out: list[str] = []
    ohne = _ohne_zahl(text, zahl)
    if ohne is not None:
        out.append(ohne)
    out.append(text)
    return out


def _linke_kanten(cur: Segment, segs: list[Segment]) -> list[float]:
    """Wo eine Folgezeile von `cur` beginnen darf.

    Buendig mit dem Text — oder mit einer freistehenden Seitenzahl daneben:
    im Anreisser steht die grosse Zahl vor dem Titel, und die Unterzeile
    darunter beginnt an der Zahl, nicht am eingerueckten Titel.
    """
    kanten = [cur.text_x0, cur.x0]
    for s in segs:
        if (
            s.numeric
            and _ueberlappung(s, cur) >= 0.3 * (s.y1 - s.y0)
            and _abstand(s, cur) <= 0.08
        ):
            kanten.append(s.x0)
    return kanten


def _zeile_darunter(cur: Segment, segs: list[Segment]) -> Segment | None:
    """Die naechste Textzeile unmittelbar unter `cur` in derselben Spalte."""
    kanten = _linke_kanten(cur, segs)
    kandidaten = [
        s
        for s in segs
        if s is not cur
        and not s.numeric
        and s.y0 >= cur.text_y1 - 0.3 * cur.text_height
        and any(abs(s.text_x0 - k) <= BUENDIG for k in kanten)
    ]
    if not kandidaten:
        return None
    nxt = min(kandidaten, key=lambda s: s.y0)
    hoehe = max(cur.text_height, nxt.text_height, 0.004)
    if nxt.y0 - cur.text_y1 > ZEILENABSTAND * hoehe:
        return None
    return nxt


def _titel_finden(hint: TocHint, segs: list[Segment]) -> list[list[Segment]]:
    """Alle Stellen, an denen der Titel des Eintrags steht (eine oder mehrere Zeilen)."""
    lab = _norm(hint.label)
    if not lab:
        return []
    treffer: list[list[Segment]] = []
    for s in segs:
        if s.numeric:
            continue
        for variante in _varianten(s.text, hint.printed):
            acc = _norm(variante)
            if not acc or not lab.startswith(acc):
                continue
            zeilen = [s]
            cur = s
            while acc != lab and len(zeilen) < MAX_TITELZEILEN:
                nxt = _zeile_darunter(cur, segs)
                if nxt is None:
                    break
                weiter = next(
                    (
                        n
                        for n in (_norm(v) for v in _varianten(nxt.text, hint.printed))
                        if n and lab.startswith(acc + n)
                    ),
                    None,
                )
                if weiter is None:
                    break
                acc += weiter
                zeilen.append(nxt)
                cur = nxt
            if acc == lab:
                treffer.append(zeilen)
                break
    return treffer


def _ueberlappung(a: Segment, b: Segment) -> float:
    return min(a.y1, b.y1) - max(a.y0, b.y0)


def _abstand(a: Segment, b: Segment) -> float:
    return max(0.0, a.x0 - b.x1, b.x0 - a.x1)


def _zahl_daneben(
    zeilen: list[Segment], segs: list[Segment], zahl: int | None
) -> Segment | None:
    """Die gedruckte Seitenzahl neben dem Titel, falls sie ein eigenes Stueck ist."""
    if zahl is None:
        return None
    if any(_ohne_zahl(z.text, zahl) is not None for z in zeilen):
        # Sie steht schon in der Titelzeile ("5 Schicksalsschlacht").
        return None
    y0 = min(z.y0 for z in zeilen)
    y1 = max(z.y1 for z in zeilen)
    x0 = min(z.x0 for z in zeilen)
    x1 = max(z.x1 for z in zeilen)
    rahmen = Segment([TextItem("", x0, y0, x1, y1)])
    beste: tuple[float, Segment] | None = None
    for s in segs:
        if s.zahl != zahl:
            continue
        if _ueberlappung(s, rahmen) < 0.3 * (s.y1 - s.y0):
            continue
        abstand = _abstand(s, rahmen)
        if abstand > ZAHLABSTAND:
            continue
        if beste is None or abstand < beste[0]:
            beste = (abstand, s)
    return beste[1] if beste else None


def _unterzeilen(zeilen: list[Segment], segs: list[Segment], details: str) -> list[Segment]:
    """Die Zeilen der Unterzeile direkt unter dem Titel, soweit ihr Text passt."""
    det = _norm(details)
    if not det:
        return []
    out: list[Segment] = []
    acc = ""
    cur = zeilen[-1]
    while acc != det and len(out) < MAX_UNTERZEILEN:
        nxt = _zeile_darunter(cur, segs)
        if nxt is None:
            break
        n = _norm(nxt.text)
        if not n or not det.startswith(acc + n):
            break
        acc += n
        out.append(nxt)
        cur = nxt
    return out


def _ueber_zahl(
    hint: TocHint, segs: list[Segment], belegt: set[int]
) -> tuple[list[Segment], Segment | None] | None:
    """Rueckweg, wenn der Titel nicht woertlich zu finden ist: die Seitenzahl.

    Steht die gedruckte Zahl genau einmal auf der Seite — frei neben einer
    Zeile oder am Anfang bzw. Ende einer Zeile —, ist diese Zeile der
    Eintrag. Mehrdeutig heisst: lieber keine Flaeche als eine falsche.
    """
    if hint.printed is None:
        return None
    frei = [s for s in segs if s.zahl == hint.printed and id(s) not in belegt]
    inline = [
        s
        for s in segs
        if not s.numeric
        and id(s) not in belegt
        and (_ohne_zahl(s.text, hint.printed) or "") != ""
    ]
    if len(frei) + len(inline) != 1:
        return None
    if inline:
        return [inline[0]], None
    zahl = frei[0]
    daneben = [
        s
        for s in segs
        if not s.numeric
        and _ueberlappung(s, zahl) >= 0.3 * min(s.y1 - s.y0, zahl.y1 - zahl.y0)
        and _abstand(s, zahl) <= ZAHLABSTAND
    ]
    if not daneben:
        return None
    return [min(daneben, key=lambda s: _abstand(s, zahl))], zahl


def _flaeche(teile: list[Segment]) -> tuple[float, float, float, float]:
    x0 = min(s.x0 for s in teile) - RAND_X
    y0 = min(s.y0 for s in teile) - RAND_Y
    x1 = max(s.x1 for s in teile) + RAND_X
    y1 = max(s.y1 for s in teile) + RAND_Y
    return (
        max(0.0, x0),
        max(0.0, y0),
        min(1.0, x1),
        min(1.0, y1),
    )


def refine_toc_hints(
    hints: list[TocHint], text_by_page: dict[int, list[TextItem]]
) -> tuple[list[TocHint], dict[str, int]]:
    """Jeden Eintrag auf seine gedruckten Zeilen legen.

    Liefert die neuen Hinweise und eine Bilanz: `placed` ueber den Titel
    gefunden, `byNumber` nur ueber die Seitenzahl, `unplaced` nicht gefunden
    (der Eintrag bleibt im Verzeichnis, bekommt aber keine Klickflaeche —
    besser als eine, die auf dem Nachbareintrag liegt), `noText` Seiten ohne
    Textebene (Schaetzwert bleibt), `overlapping` Flaechenpaare, die sich
    trotz allem deutlich ueberschneiden — ein Zeichen, dass ein Eintrag auf
    dem falschen Fundort liegt.
    """
    bilanz = {"placed": 0, "byNumber": 0, "unplaced": 0, "noText": 0, "overlapping": 0}
    segs_je_seite: dict[int, list[Segment]] = {}
    belegt: set[int] = set()
    out: list[TocHint] = []
    for hint in hints:
        seite = hint.toc_page_index
        if seite is None:
            out.append(hint)
            continue
        if seite not in text_by_page:
            bilanz["noText"] += 1
            out.append(hint)
            continue
        segs = segs_je_seite.setdefault(seite, segments_of(text_by_page[seite]))
        treffer = _titel_finden(hint, segs)
        if treffer:
            # Bei gleichlautenden Eintraegen (Spalte und Anreisser) gewinnt der
            # Fundort, der dem Schaetzwert aus dem Satz am naechsten liegt.
            zeilen = min(
                treffer,
                key=lambda z: abs(z[0].text_x0 - hint.x0) + abs(z[0].y0 - hint.y0),
            )
            zahl = _zahl_daneben(zeilen, segs, hint.printed)
            unter = _unterzeilen(zeilen, segs, hint.details)
            bilanz["placed"] += 1
        else:
            rueckweg = _ueber_zahl(hint, segs, belegt)
            if rueckweg is None:
                bilanz["unplaced"] += 1
                out.append(replace(hint, toc_page_index=None))
                continue
            zeilen, zahl = rueckweg
            unter = []
            bilanz["byNumber"] += 1
        belegt.add(id(zahl) if zahl is not None else id(zeilen[0]))
        x0, y0, x1, y1 = _flaeche(zeilen + ([zahl] if zahl else []) + unter)
        out.append(replace(hint, x0=x0, y0=y0, x1=x1, y1=y1))
    _nachbarn_trennen(out)
    bilanz["overlapping"] = _ueberschneidungen(out)
    out.sort(key=lambda h: (h.page_index, h.toc_page_index or 0, h.y0))
    return out, bilanz


def _ueberschneidungen(hints: list[TocHint]) -> int:
    """Wie viele Flaechenpaare derselben Seite sich deutlich ueberschneiden."""
    je_seite: dict[int, list[TocHint]] = {}
    for h in hints:
        if h.toc_page_index is not None:
            je_seite.setdefault(h.toc_page_index, []).append(h)
    paare = 0
    for gruppe in je_seite.values():
        for i, a in enumerate(gruppe):
            for b in gruppe[i + 1 :]:
                schnitt = max(0.0, min(a.x1, b.x1) - max(a.x0, b.x0)) * max(
                    0.0, min(a.y1, b.y1) - max(a.y0, b.y0)
                )
                kleinste = min(
                    (a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0)
                )
                if kleinste > 0 and schnitt > 0.2 * kleinste:
                    paare += 1
    return paare


def _nachbarn_trennen(hints: list[TocHint]) -> None:
    """Untereinanderstehende Flaechen teilen sich die Luecke, statt sich zu ueberlappen.

    Der Rand um die Zeilen reicht bei eng gesetzten Verzeichnissen in den
    Nachbareintrag hinein; gross gesetzte Seitenzahlen (DMZ, 18 pt in einer
    Liste mit engerem Zeilenabstand) ueberlappen sich schon ohne Rand.
    Ueberlappen sich zwei Flaechen derselben Spalte um weniger als die halbe
    Hoehe der kleineren, endet die obere und beginnt die untere in der Mitte
    der Ueberlappung. Mehr waere kein Randproblem, sondern derselbe Fundort —
    das bleibt stehen und zaehlt als Ueberschneidung.
    """
    je_seite: dict[int, list[TocHint]] = {}
    for h in hints:
        if h.toc_page_index is not None:
            je_seite.setdefault(h.toc_page_index, []).append(h)
    for gruppe in je_seite.values():
        gruppe.sort(key=lambda h: (h.y0, h.x0))
        for i, oben in enumerate(gruppe):
            for unten in gruppe[i + 1 :]:
                breite = min(oben.x1 - oben.x0, unten.x1 - unten.x0)
                seitlich = min(oben.x1, unten.x1) - max(oben.x0, unten.x0)
                if breite <= 0 or seitlich < 0.5 * breite:
                    continue
                ueberlappung = oben.y1 - unten.y0
                hoehe = min(oben.y1 - oben.y0, unten.y1 - unten.y0)
                if ueberlappung <= 0 or ueberlappung > 0.5 * hoehe:
                    continue
                mitte = (oben.y1 + unten.y0) / 2
                oben.y1 = mitte
                unten.y0 = mitte
