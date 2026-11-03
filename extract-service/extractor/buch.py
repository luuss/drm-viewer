"""Ein Heft als ein durchgehender Text (Buch-Modus, Weltkrieg-Leser).

Die Hefte von weltkrieg-online.de sind Erzaehlungen: eine Geschichte ueber
120 Seiten, davor eine Einleitung, dazwischen Fussnoten und ein paar Bilder.
Die Zeitschriften-Regeln (`artikel_aus_satz`) zerlegen ein Heft nach den
Absatzformaten in Artikel. Bei Weltkrieg taugt das nicht: dort ist der ganze
Fliesstext im Format "weltkrieg kapitelüberschrift" gesetzt (Heft 159, 50
Absatzgruppen, 201.000 Zeichen), der Import hielt ihn fuer eine Ueberschrift
und warf die Geschichte weg. Uebrig blieben Einleitung und Bildnachweis.

Hier entscheidet deshalb nicht das Format, sondern die Lage: jeder Absatz
des Satzes kommt in einen einzigen Text, in der Reihenfolge der Druckseiten
und innerhalb einer Seite in der Reihenfolge der Story. Nur Beiwerk (Pagina,
Kolumnentitel, Verzeichnis), Bildunterschriften und Beschriftungen in Karten
bleiben draussen; Bildunterschriften haengen schon an ihren Bildern.

Eingeschaltet wird der Modus fuer die ganze Anlage (`IMPORT_MODUS=buch` am
Import-Worker), nicht fuer ein einzelnes Heft.
"""

from __future__ import annotations

import re

from .idml_articles import (
    _als,
    grafikbeschriftungen,
    initialen_einsetzen,
    rolle_fuer,
    stories_bilden,
    zeilen_zusammenfuehren,
)
from .model import AssembledArticle, SourceBlock, SourceImage

# Rollen, die nie in den Lesetext gehoeren.
DRAUSSEN = {"beiwerk", "verzeichnis", "bildunterschrift", "grafik", "schmuckzitat"}
# Rollen, die am Ende stehen statt an ihrer Seite.
ANS_ENDE = {"quelle"}
# Ein Szenenwechsel ("* * *") bleibt als eigener Absatz stehen.
TRENNER = re.compile(r"^[\s*·•⁂~–-]{1,12}$")
# Eine Kapitelzeile ist kurz, endet ohne Satzzeichen und steht vor langem Text.
KAPITEL_HOECHSTLAENGE = 80
KAPITEL_FOLGETEXT = 200
SATZENDE = tuple(".,;:!?…\"“”«»)")


def _rolle(block: SourceBlock) -> str:
    return rolle_fuer(block.style_name, len(block.text))


# Bildnachweise und Lizenzen stehen in eigenen kleinen Rahmen am Bild.
NACHWEIS = re.compile(
    r"^\s*(bild(quelle|nachweis)|foto|quelle)\b|cc[ -]by|cc0|wikimedia|public domain|bundesarchiv",
    re.I,
)


def _sieht_aus_wie_kapitel(text: str) -> bool:
    text = text.strip()
    if not text or len(text) > KAPITEL_HOECHSTLAENGE or TRENNER.match(text):
        return False
    return not text.endswith(SATZENDE) and not text[0].islower()


def _ist_kapitelzeile(block: SourceBlock, folgender: SourceBlock | None) -> bool:
    if not _sieht_aus_wie_kapitel(block.text):
        return False
    return folgender is not None and len(folgender.text) >= KAPITEL_FOLGETEXT


# Kleine Stories neben dem Haupttext sind Bildunterschriften, Bildnachweise
# und Kartenzeilen. Ihr Format sagt es nicht (bei Weltkrieg steht alles im
# selben Format), ihre Groesse schon. Fussnoten ("* AOK = …") bleiben.
BEIWERK_STORY_HOECHSTZEICHEN = 400
FUSSNOTE = re.compile(r"^\s*\*")


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def _ist_fussnote(story) -> bool:
    return any(
        FUSSNOTE.match(b.text) or "fußnote" in (b.style_name or "").lower()
        or "fussnote" in (b.style_name or "").lower()
        for b in story.blocks
    )


def buch_aus_satz(
    blocks: list[SourceBlock],
    images: list[SourceImage] | None = None,
    titel: str | None = None,
) -> list[AssembledArticle]:
    """Den ganzen Satz eines Hefts als einen Text."""
    stories = initialen_einsetzen(stories_bilden(blocks))
    grafik = grafikbeschriftungen(stories, images)
    rang = {s.story_id: n for n, s in enumerate(stories)}
    haupt = max(stories, key=lambda s: s.textzeichen, default=None)
    # Texte, die schon als Unterschrift oder Nachweis an einem Bild haengen.
    am_bild = {
        _norm(t)
        for i in (images or [])
        for t in (getattr(i, "caption", None), getattr(i, "credit", None))
        if t
    }

    # Seiten mit einem Anzeigenbild (Abo-Werbung mit Heftumschlaegen): kleine
    # Stories dort gehoeren zur Anzeige, nicht in den Text.
    anzeigenseiten = {i.page_index for i in (images or []) if getattr(i, "anzeige", False)}
    lesetext: list[tuple[int, float, int, int, SourceBlock]] = []
    # Die Art der Bloecke stammt aus dem Format und taugt hier nicht; welche
    # Zeile Kapitel ist, steht allein in dieser Menge.
    kapitelzeilen: set[int] = set()
    ende: list[SourceBlock] = []
    for story in stories:
        if story.story_id in grafik:
            continue
        kapitel = False
        if story is not haupt and not _ist_fussnote(story):
            ganz = _norm(" ".join(b.text for b in story.blocks))
            if ganz in am_bild or any(_norm(b.text) in am_bild for b in story.blocks):
                continue
            if story.textzeichen < BEIWERK_STORY_HOECHSTZEICHEN and story.erste_seite in anzeigenseiten:
                continue
            if story.textzeichen < BEIWERK_STORY_HOECHSTZEICHEN:
                # Eine Kapitelzeile im eigenen Rahmen ("Der Vorstoß auf
                # Libau") bleibt; ein Bildnachweis oder eine Kartenzeile nicht.
                if (
                    len(story.blocks) == 1
                    and not NACHWEIS.search(story.blocks[0].text)
                    and _sieht_aus_wie_kapitel(story.blocks[0].text)
                ):
                    kapitel = True
                else:
                    continue
        for n, b in enumerate(story.blocks):
            if b.drop or not b.text.strip():
                continue
            rolle = _rolle(b)
            if rolle in DRAUSSEN:
                continue
            if rolle in ANS_ENDE:
                ende.append(b)
                continue
            if kapitel:
                kapitelzeilen.add(id(b))
            lesetext.append((b.page_index, b.y0, rang[story.story_id], n, b))

    # Druckseite zuerst, dann die Hoehe auf der Seite (die Hefte sind
    # einspaltig gesetzt), dann Story und Absatz. So steht die Kapitelzeile
    # vor dem Text darunter und die Fussnote hinter dem letzten Absatz ihrer
    # Seite, nicht am Heftende.
    lesetext.sort(key=lambda t: (t[0], t[1], t[2], t[3]))
    folge = [t[4] for t in lesetext]

    # Eine Kapitelzeile, die es schon gab, ist kein neues Kapitel, sondern die
    # Ueberschrift einer Karte oder eines Bildes (Heft 159 S. 12).
    gesehen: set[str] = set()
    for b in folge:
        if id(b) in kapitelzeilen:
            if _norm(b.text) in gesehen:
                kapitelzeilen.discard(id(b))
                folge = [x for x in folge if x is not b]
            else:
                gesehen.add(_norm(b.text))

    aus: list[SourceBlock] = []
    haupt_id = haupt.story_id if haupt else None
    for i, b in enumerate(folge):
        naechster = folge[i + 1] if i + 1 < len(folge) else None
        if b.kind == "table":
            aus.append(b)
        elif id(b) in kapitelzeilen:
            aus.append(_als(b, "heading"))
        elif (
            b.story_id == haupt_id
            and not FUSSNOTE.match(b.text)
            and _ist_kapitelzeile(b, naechster)
        ):
            aus.append(_als(b, "heading"))
        else:
            aus.append(_als(b, "paragraph"))
    aus.extend(_als(b, "paragraph") for b in ende)
    if not aus:
        return []
    aus = zeilen_zusammenfuehren(aus)

    erster_titel = next((b.text.strip() for b in aus if b.kind == "heading"), None)
    stueck = AssembledArticle(
        title=(titel or erster_titel or "Ganzes Heft").strip(),
        blocks=aus,
    )
    stueck.images = [i for i in (images or []) if not getattr(i, "anzeige", False)]
    return [stueck]
