"""Einzelne Buecher auf einer Seite erkennen: je Buch eine Klickflaeche in den Laden.

Eine Bucherseite ("Buecher gegen den Zeitgeist" in ZUERST!, die Bucherseite der
DMZ, die Kataloge der DMZ-Zeitgeschichte) zeigt viele Buecher nebeneinander:
je Buch ein Umschlagbild und darunter ein Textrahmen mit Verfasser, Titel,
kurzem Text, Umfang und Preis. Die Anzeige als Ganzes ist ein Artikel; im
Seitenmodus soll aber ein Tipp auf ein Buch genau dieses Buch im Laden
oeffnen, nicht eine Liste aller Buecher der Seite.

Zwei Formen werden erkannt, beide aus dem Satz (IDML):

* **Kachel** — ein kurzer Textrahmen mit Preis, in dem Verfasser und Titel
  stehen (Absatzformate "... autor" und "... titel", sonst die ersten kurzen
  Absaetze). Die Flaeche ist das Umschlagbild darueber oder daneben: ein
  Tipp auf den Umschlag oeffnet das Buch im Laden, ein Tipp auf den Text den
  Text. Ohne erkennbaren Umschlag ist es der Rahmen. Stehen in einem Rahmen
  zwei Buecher untereinander (Anzeige unter einem Interview: "Manfred
  Kleine-Hartlage: BRD-Sprech" und "Die Sprache der BRD"), wird jedes ein
  eigenes Buch mit eigenem Umschlag.
* **Literaturangabe** einer Buchbesprechung ("Verfasser. Titel. 288 S., geb.,
  € 18,–."). Die Flaeche ist das abgebildete Umschlagbild; welches Bild zu
  welcher Angabe gehoert, verraet der Dateiname ("verheimlicht 2026.tif").
  Ohne passendes Bild bekommt die Angabe keine Flaeche: der Knopf am Artikel
  fuehrt dann weiter in den Laden.

Was der Laden zu Titel und Verfasser fuehrt, entscheidet das Backend
(convex/pageLinks.ts, `chooseBook`): nur ein Produkt, dessen Name zum Titel
passt; sonst die Suchseite des Titels.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from .anzeige import artikelnummern
from .model import SourceBlock, SourceImage

# Preis wie in anzeige.py: "€ 18,–", "t 29,80" (DMZ-Schrift), "32,80 EUR".
_PREIS = re.compile(
    r"(?:€|EUR|(?<![A-Za-zÄÖÜäöüß])t)\s?\d{1,3}(?:\.\d{3})*,(?:\d{2}|[–—-])"
    r"|\d{1,3}(?:\.\d{3})*,(?:\d{2}|[–—-])\s?(?:€|EUR)",
    re.I,
)
# Umfang: "288 S.,", "256 Seiten".
_UMFANG = re.compile(r"(?<![\d.,])(?:\d{2,4}|\d\.\d{3})\s?(?:S\.|Seiten\b)")
# Literaturangabe: "Verfasser. Titel. 288 S., ..." — der Verfasser endet am
# ersten Punkt nach mindestens einem Wort, der Titel am Umfang.
_ANGABE = re.compile(
    r"^(?P<autor>[^.]{3,90}?(?:\(Hrsg?\.\)|\(Hg\.\))?)\.\s+(?P<titel>.{3,240}?)[.?!]?\s+"
    r"(?:\d{2,4}|\d\.\d{3})\s?S\.,"
)
# Ein Kachelrahmen ist kurz; ein langer Artikel mit einem Preis ist keine Kachel.
MAX_KACHEL_ZEICHEN = 1500
# Mehr Preise in einem Rahmen sind eine Liste, kein einzelnes Buch.
MAX_KACHEL_PREISE = 2
# Kurze Absaetze vor dem Text: Verfasser, Titel, Untertitel.
MAX_KOPF_ZEICHEN = 120
# Kein Titel einer Kachel: Kopf eines Impressums oder einer Rubrik.
_KEIN_TITEL = re.compile(r"^(?:Impressum|Kleinanzeigen|Inhalt|Leserbriefe)\b", re.I)
_FUELL = {
    "der", "die", "das", "den", "dem", "des", "ein", "eine", "einer", "und",
    "oder", "mit", "von", "vom", "zum", "zur", "aus", "bei", "nach", "über",
    "ueber", "fuer", "für", "im", "in", "am", "an", "auf", "zu", "als", "wie",
    "tif", "tiff", "jpg", "jpeg", "png", "psd", "eps", "pdf",
}


@dataclass(frozen=True)
class Buch:
    """Ein Buch auf einer Leserseite, mit Flaeche und Suchangaben."""

    page_index: int
    x0: float
    y0: float
    x1: float
    y1: float
    titel: str
    autor: str | None = None
    referenz: str | None = None

    def als_link(self) -> dict:
        """Die Seitenflaeche fuer `/service/jobs/result` (`pageLinks`).

        `label` traegt Titel und Verfasser, getrennt durch " · " — daran
        erkennt das Backend eine Buchflaeche und prueft den Titel streng.
        """
        nachname = _nachname(self.autor)
        queries = [self.titel[:80]]
        if nachname and nachname.lower() not in self.titel.lower():
            queries.append(f"{self.titel[:70]} {nachname}")
        link = {
            "pageIndex": self.page_index,
            "x0": round(self.x0, 5),
            "y0": round(self.y0, 5),
            "x1": round(self.x1, 5),
            "y1": round(self.y1, 5),
            "kind": "shop",
            "queries": queries,
            "single": True,
            "label": f"{self.titel} · {self.autor or ''}"[:120],
        }
        if self.referenz:
            link["reference"] = self.referenz
        return link


def _einfach(text: str) -> str:
    """Kleinbuchstaben, ohne Akzente und Satzzeichen, ß als ss."""
    t = unicodedata.normalize("NFKD", text.replace("ß", "ss").replace("‑", "-"))
    t = "".join(c for c in t if not unicodedata.combining(c)).lower()
    return re.sub(r"[^a-z0-9]+", " ", t).strip()


def _woerter(text: str) -> list[str]:
    return [w for w in _einfach(text).split() if len(w) >= 3 and w not in _FUELL]


def _nachname(autor: str | None) -> str | None:
    """Der Nachname des ersten Verfassers ("Gunter Frank/Martina Binnig" → Frank)."""
    if not autor:
        return None
    erster = re.split(r"[/,;&]| und ", autor)[0]
    erster = re.sub(r"\((?:Hrsg?|Hg)\.\)", "", erster).strip(" .")
    teile = [t for t in erster.split() if t[:1].isupper() and len(t) > 1]
    return teile[-1].strip(".") if teile else None


def haupttitel(titel: str) -> str:
    """Der Titel ohne Untertitel: bis zum Gedankenstrich oder Doppelpunkt."""
    t = " ".join(titel.replace("‑", "-").split())
    for trenner in (" – ", " — ", ": ", ". "):
        if trenner in t:
            kopf = t.split(trenner, 1)[0].strip()
            if len(_woerter(kopf)) >= 1:
                t = kopf
    return t.strip(" .,;:")


def _sieht_aus_wie_name(text: str) -> bool:
    """"Peter Hahne", "Gunter Frank/Martina Binnig", "Ben Krischke (Hg.)"."""
    t = re.sub(r"\((?:Hrsg?|Hg)\.\)", "", text).strip(" /")
    if not t or len(t) > 90 or re.search(r"\d", t):
        return False
    woerter = [w for w in re.split(r"[\s/]+", t) if w]
    if not 2 <= len(woerter) <= 9:
        return False
    gross = sum(1 for w in woerter if w[:1].isupper() or w in ("v.", "von", "van", "de", "zu"))
    return gross == len(woerter)


def _kopf_der_kachel(absaetze: list[SourceBlock]) -> tuple[str | None, str | None]:
    """Verfasser und Titel einer Kachel.

    Zuerst die Absatzformate des Satzes ("werbeseite autor", "Bücherseite
    Titel 2023", "Autorenname Katalog", "Buchtitel Katalog"). Fehlen sie, die
    kurzen Absaetze vor dem Text: ein Name zuerst ist der Verfasser, der
    naechste der Titel.
    """
    autor = [b.text.strip() for b in absaetze if re.search(r"autor", b.style_name or "", re.I)]
    titel = [b.text.strip() for b in absaetze if re.search(r"titel", b.style_name or "", re.I)]
    if titel:
        # Verfasser in mehreren Zeilen ("Alexander Marguier/" "Ben Krischke (Hg.)").
        a = " ".join(autor).replace("/ ", "/") if autor else None
        return a or None, " ".join(titel)
    kopf: list[str] = []
    for b in absaetze:
        t = b.text.strip()
        if not t:
            continue
        if len(t) > MAX_KOPF_ZEICHEN or _PREIS.search(t) or _UMFANG.search(t):
            break
        if re.match(r"^(?:Art(?:ikel)?\.?\s*(?:-?\s*Nr\.?)?)\s*\d", t, re.I):
            continue
        # Mehrere Verfasser ueber zwei Zeilen: "Alfred de Zayas/" "Konrad Badenheuer".
        if kopf and kopf[-1].endswith("/"):
            kopf[-1] += t
            continue
        kopf.append(t)
    if not kopf:
        return None, None
    if len(kopf) >= 2 and _sieht_aus_wie_name(kopf[0]):
        return kopf[0], kopf[1]
    return _autor_vor_doppelpunkt(kopf[0])


def _autor_vor_doppelpunkt(zeile: str) -> tuple[str | None, str]:
    """"Manfred Kleine-Hartlage: BRD-Sprech" → Verfasser und Titel.

    Nur wenn der Teil vor dem Doppelpunkt wie ein Name aussieht:
    "Kalender: Maenner der Waffen-SS" und "2025: Verheimlicht …" bleiben Titel.
    """
    kopf, sep, rest = zeile.partition(": ")
    if sep and rest.strip() and _sieht_aus_wie_name(kopf) and _woerter(rest):
        return kopf.strip(), rest.strip()
    return None, zeile


def _ueberlappung(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


def _bild_passt_zum_titel(bild: SourceImage, titel: str) -> float:
    """Wie gut der Dateiname des Bildes den Titel nennt (0 bis 1).

    Gezaehlt werden die tragenden Titelwoerter im Namen, auch abgeschnitten
    ("generalfeldmarschälle.tif" zu "Die deutschen Generalfeldmarschälle und
    Großadmirale"). Ein einzelnes gemeinsames Wort reicht nur bei einem
    einwortigen Titel — sonst passte "deutsche_Soldaten.tif" zu jedem Buch
    mit "deutsche" im Titel.
    """
    if not bild.link:
        return 0.0
    name = set(_woerter(bild.link.rsplit(".", 1)[0]))
    woerter = _woerter(haupttitel(titel))
    if not woerter or not name:
        return 0.0
    treffer = sum(
        1 for w in woerter if w in name or (len(w) >= 6 and any(n.startswith(w[:6]) for n in name))
    )
    if treffer == 0 or (treffer == 1 and len(woerter) > 1 and len(woerter[0]) < 8):
        return 0.0
    return max(treffer / len(woerter), 0.5 if treffer >= 2 or len(woerter) == 1 else 0.0)


def _umschlag_der_kachel(
    kasten: tuple[float, float, float, float],
    titel: str,
    bilder: list[SourceImage],
    vergeben: set[int],
    nur_name: bool = False,
) -> int | None:
    """Das Umschlagbild zu einer Kachel.

    Es steht direkt ueber dem Text (ZUERST!, DMZ-Bucherseite), daneben
    (Kataloge, Soldatenportraet der DMZ) oder im Rahmen selbst. Ein Bild weiter
    weg zaehlt nur, wenn sein Dateiname den Titel nennt.
    """
    beste: tuple[float, int] | None = None
    for i, b in enumerate(bilder):
        if i in vergeben:
            continue
        name = _bild_passt_zum_titel(b, titel)
        breite = min(b.x1 - b.x0, kasten[2] - kasten[0])
        hoehe = min(b.y1 - b.y0, kasten[3] - kasten[1])
        spalte = breite > 0 and _ueberlappung(b.x0, b.x1, kasten[0], kasten[2]) >= 0.5 * breite
        zeile = hoehe > 0 and _ueberlappung(b.y0, b.y1, kasten[1], kasten[3]) >= 0.5 * hoehe
        ueber = kasten[1] - b.y1
        neben = max(kasten[0] - b.x1, b.x0 - kasten[2])
        nah = (spalte and -0.02 <= ueber <= 0.06) or (zeile and neben <= 0.05)
        if (not nah or nur_name) and name < (0.5 if nur_name else 0.6):
            continue
        punkte = name * 2 + (1.0 if nah else 0.0) - 0.1 * max(0.0, ueber if spalte else neben)
        if beste is None or punkte > beste[0]:
            beste = (punkte, i)
    return beste[1] if beste else None


def _beschreibt(text: str) -> bool:
    return bool(_PREIS.search(text) or _UMFANG.search(text))


def _buecher_im_rahmen(absaetze: list[SourceBlock]) -> list[list[SourceBlock]]:
    """Die Buecher eines Rahmens, je Buch seine Absaetze.

    Ein neues Buch beginnt mit einer kurzen Kopfzeile nach einer
    Beschreibung mit Umfang oder Preis. Nur wenn so mindestens zwei Buecher
    mit Preis entstehen, wird geteilt; Zeilen ohne Preis am Ende ("Jetzt
    bestellen!") bleiben beim letzten Buch.
    """
    gruppen: list[list[SourceBlock]] = [[]]
    beschrieben = False
    for b in absaetze:
        t = b.text.strip()
        kopfzeile = bool(t) and len(t) <= MAX_KOPF_ZEICHEN and not _beschreibt(t)
        if beschrieben and kopfzeile and not re.match(r"^(?:Art(?:ikel)?\.?\s*(?:-?\s*Nr\.?)?)\s*\d", t, re.I):
            gruppen.append([])
            beschrieben = False
        gruppen[-1].append(b)
        if _beschreibt(t):
            beschrieben = True
    mit_preis = [g for g in gruppen if _PREIS.search(" ".join(b.text for b in g))]
    if len(mit_preis) < 2:
        return [absaetze]
    out: list[list[SourceBlock]] = []
    for g in gruppen:
        if out and not _PREIS.search(" ".join(b.text for b in g)):
            out[-1].extend(g)
        else:
            out.append(g)
    return out


def kacheln(blocks: list[SourceBlock], bilder: list[SourceImage]) -> list[Buch]:
    """Die Buchkacheln aller Seiten: kurze Textrahmen mit Preis, Verfasser und Titel."""
    rahmen: dict[tuple[int, str], list[SourceBlock]] = {}
    for b in blocks:
        if b.origin != "idml" or not b.frame_id or b.frame_box is None:
            continue
        rahmen.setdefault((b.page_index, b.frame_id), []).append(b)

    buecher: list[Buch] = []
    vergeben: dict[int, set[int]] = {}
    for (seite, _fid), absaetze in sorted(rahmen.items(), key=lambda kv: kv[0]):
        text = " ".join(b.text for b in absaetze)
        if len(text) > MAX_KACHEL_ZEICHEN:
            continue
        preise = len(_PREIS.findall(text))
        nummern = artikelnummern(text)
        if not 1 <= preise <= MAX_KACHEL_PREISE or len(nummern) > 1:
            continue
        if not (_UMFANG.search(text) or nummern):
            continue
        gruppen = _buecher_im_rahmen(absaetze)
        mehrere = len(gruppen) > 1
        kasten = absaetze[0].frame_box
        auf_seite = [i for i in bilder if i.page_index == seite]
        frei = vergeben.setdefault(seite, set())
        for gruppe in gruppen:
            gtext = " ".join(b.text for b in gruppe) if mehrere else text
            gnummern = artikelnummern(gtext) if mehrere else nummern
            if mehrere and not (_UMFANG.search(gtext) or gnummern):
                continue
            autor, titel = _kopf_der_kachel(gruppe)
            if not titel or _KEIN_TITEL.match(titel) or not _woerter(titel):
                continue
            # Teilen sich mehrere Buecher einen Rahmen, sagt die Lage nichts
            # ueber das Buch: nur ein Bild, dessen Dateiname den Titel nennt.
            bild_nr = _umschlag_der_kachel(kasten, titel, auf_seite, frei, nur_name=mehrere)
            if bild_nr is not None:
                frei.add(bild_nr)
                bild = auf_seite[bild_nr]
                x0, y0, x1, y1 = bild.x0, bild.y0, bild.x1, bild.y1
            elif mehrere:
                continue
            else:
                x0, y0, x1, y1 = kasten
            buecher.append(
                Buch(
                    page_index=seite,
                    x0=x0,
                    y0=y0,
                    x1=x1,
                    y1=y1,
                    titel=" ".join(titel.split()),
                    autor=" ".join(autor.split()) if autor else None,
                    referenz=gnummern[0] if gnummern else None,
                )
            )
    return buecher


def literaturangaben(
    blocks: list[SourceBlock], bilder: list[SourceImage], belegt: set[tuple[int, int]] | None = None
) -> list[Buch]:
    """Besprochene Buecher: Literaturangabe im Text, Flaeche auf ihrem Umschlagbild."""
    buecher: list[Buch] = []
    for b in blocks:
        if b.origin != "idml":
            continue
        t = " ".join(b.text.split())
        m = _ANGABE.match(t)
        if not m or not _PREIS.search(t[m.end() - 6 :][:200]):
            continue
        autor, titel = m.group("autor").strip(), m.group("titel").strip()
        if not _sieht_aus_wie_name(autor):
            continue
        # Das Umschlagbild steht auf der Seite der Angabe oder davor (die
        # Besprechung beginnt mit dem Bild, die Angabe steht am Ende).
        kandidaten = [
            (i, img)
            for i, img in enumerate(bilder)
            if b.page_index - 1 <= img.page_index <= b.page_index
            and (img.page_index, i) not in (belegt or set())
        ]
        beste = max(
            kandidaten, key=lambda kv: (_bild_passt_zum_titel(kv[1], titel), kv[1].page_index),
            default=None,
        )
        if beste is None or _bild_passt_zum_titel(beste[1], titel) < 0.5:
            continue
        img = beste[1]
        if belegt is not None:
            belegt.add((img.page_index, beste[0]))
        buecher.append(
            Buch(
                page_index=img.page_index,
                x0=img.x0,
                y0=img.y0,
                x1=img.x1,
                y1=img.y1,
                titel=haupttitel(titel),
                autor=autor,
            )
        )
    return buecher


def buecher_der_seiten(blocks: list[SourceBlock], bilder: list[SourceImage]) -> list[Buch]:
    """Alle Buecher eines Hefts: Kacheln und besprochene Buecher.

    Ein Bild, das schon zu einer Kachel gehoert, wird nicht noch einmal einer
    Literaturangabe zugeordnet; dasselbe Buch auf derselben Seite nur einmal.
    """
    k = kacheln(blocks, bilder)
    belegt = {
        (i.page_index, n)
        for n, i in enumerate(bilder)
        for b in k
        if i.page_index == b.page_index
        and b.x0 <= i.x0 + 1e-6 and b.y0 <= i.y0 + 1e-6
        and i.x1 <= b.x1 + 1e-6 and i.y1 <= b.y1 + 1e-6
    }
    alle = k + literaturangaben(blocks, bilder, belegt)
    gesehen: set[tuple[int, str]] = set()
    out: list[Buch] = []
    for b in alle:
        schluessel = (b.page_index, _einfach(haupttitel(b.titel)))
        if schluessel in gesehen:
            continue
        gesehen.add(schluessel)
        out.append(b)
    return out
