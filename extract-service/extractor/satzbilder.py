"""Bilder im Satz: Unterschrift, Beleg, Schmuck, Anzeige und Zugehoerigkeit.

Der Satz weiss ueber ein Bild mehr als seine Lage auf der Seite. Daraus
werden hier fuenf Dinge bestimmt, bevor die Artikel entstehen:

1. **Unterschrift** (`unterschriften_zuordnen`): die Story im Format
   "Bildunterschrift ..." steht im Bild, darunter, darueber oder daneben. Sie
   wird ganz genommen, alle Absaetze — der Setzer bricht eine Unterschrift oft
   Zeile fuer Zeile in Absaetze. Ein Rahmen zwischen zwei Bildern traegt durch
   eine Leerzeile getrennt die Unterschriften beider.
2. **Beleg** (`belege_setzen`): ein redaktionelles Foto traegt seine
   Unterschrift oder den Bildnachweis ("Foto: Wikimedia/...") am Rand.
   Anzeigen, Buchumschlaege und Schmuck haben beides nicht.
3. **Schmuck** (`ohne_schmuck`, `ohne_schriftzuege`): dieselbe Datei auf drei
   und mehr Seiten (Rubriksignet, Kalenderblatt, Stoerer), ein in Umrisse
   gewandelter Schriftzug mit Bild darin, ein freigestellter Ausschnitt ueber
   seinem eigenen Hintergrundbild, ein schmaler Streifen ohne Unterschrift
   und Nachweis (Titelschriftzug), die Unterschrift des Chefredakteurs unter
   der Grussformel.
4. **Anzeige** (`anzeigen_erkennen`): ein Bild mit der Kennzeichnung
   "Anzeige" daneben, ein platziertes PDF ohne Unterschrift und Nachweis, ein
   Text mit Preisen und Bestellangaben — und was ohne redaktionellen Beleg
   daran stoesst. Eine Anzeige kommt nie in einen redaktionellen Artikel; ein
   redaktionelles Foto nie in eine Anzeige.
5. **Zugehoerigkeit** (`stories_zuordnen`): die Text-Story, in deren Rahmen
   das Bild steht (der Text laeuft darum herum) oder an deren Rahmen es in
   derselben Spalte stoesst — gemessen an allen Rahmen der Story, auch an
   einem Fortsetzungsrahmen, in den die Schaetzung keinen Absatz gelegt hat.

Alle Regeln pruefen einen Beleg aus genau diesem Heft (Absatzformat, Text,
Rahmenform, Dateiname im Satz); feste Koordinaten gibt es keine.
"""

from __future__ import annotations

import os
import re
from collections import defaultdict
from dataclasses import dataclass, field

from .anzeige import _PREIS, ist_anzeige
from .idml_articles import (
    ARTIKEL_MINDESTZEICHEN,
    Story,
    _text,
    ist_buchanzeige,
    stories_bilden,
)
from .model import SourceBlock, SourceImage
from .textutil import zeilen_verbinden

Kasten = tuple[float, float, float, float]

# --- Hilfen ------------------------------------------------------------------


def _ueberdeckung(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


def _flaeche(k: Kasten) -> float:
    return max(0.0, k[2] - k[0]) * max(0.0, k[3] - k[1])


def _bildkasten(img: SourceImage) -> Kasten:
    return (img.x0, img.y0, img.x1, img.y1)


def _schnitt(a: Kasten, b: Kasten) -> float:
    return _ueberdeckung(a[0], a[2], b[0], b[2]) * _ueberdeckung(a[1], a[3], b[1], b[3])


def _abstand(a: Kasten, b: Kasten) -> float:
    """Kleinster Abstand zweier Rechtecke (0, wenn sie sich beruehren)."""
    dx = max(0.0, a[0] - b[2], b[0] - a[2])
    dy = max(0.0, a[1] - b[3], b[1] - a[3])
    return max(dx, dy)


def _rolle(story: Story) -> str:
    return story.rolle()


# --- 1. Unterschriften ---------------------------------------------------------

# So weit darf eine Unterschrift vom Bildrand abstehen (Anteil der Seite). Im
# Satz liegen die meisten buendig an (0 bis 1,4 %), neben dem Bild bis 2,6 %.
UNTERSCHRIFT_ABSTAND = 0.03
# Ab diesem Anteil liegt der Rahmen im Bild (weisse Schrift auf dem Foto).
UNTERSCHRIFT_INNEN = 0.8
# Unter dem Bild ist die Regel. Darueber oder daneben gilt nur, wenn darunter
# nichts naeher passt: im Bildraster (drei Portraets, drei Unterschriften,
# drei Portraets) steht die Unterschrift der oberen Reihe naeher am Bild der
# unteren als an ihrem eigenen.
UNTERSCHRIFT_ZUSCHLAG = {"umschliesst": 0.0, "unter": 0.0, "innen": 0.004, "ueber": 0.012, "neben": 0.016}
# Eine "Unterschrift", die nur den Nachweis nennt, ist keine.
_NACHWEIS = re.compile(
    r"^\s*(?:alle\s+)?(?:fotos?|bilder?|abb\.?|abbildungen?|grafiken?|graphiken?|karten?|"
    r"zeichnungen?|illustrationen?|quellen?|repro|montage)\b[^:]{0,40}:",
    re.I,
)
UNTERSCHRIFT_HOECHSTLAENGE = 1200


def _lage(kasten: Kasten, img: SourceImage) -> tuple[str, float] | None:
    """Wie steht der Rahmen zum Bild: innen, unter, ueber, neben — und wie weit."""
    x0, y0, x1, y1 = kasten
    breite, hoehe = x1 - x0, y1 - y0
    if breite <= 0 or hoehe <= 0:
        return None
    ix = _ueberdeckung(x0, x1, img.x0, img.x1)
    iy = _ueberdeckung(y0, y1, img.y0, img.y1)
    # Im Bild: in seiner Breite und mindestens zur Haelfte in seiner Hoehe —
    # die weisse Unterschrift ragt oft ein Stueck ueber den unteren Bildrand.
    if ix >= UNTERSCHRIFT_INNEN * breite and iy >= 0.5 * hoehe:
        return ("innen", 0.0)
    if ix >= 0.5 * min(breite, img.x1 - img.x0):
        ueberstand = -max(0.02, 0.5 * hoehe)
        unter = y0 - img.y1
        if ueberstand <= unter <= UNTERSCHRIFT_ABSTAND:
            return ("unter", max(0.0, unter))
        ueber = img.y0 - y1
        if ueberstand <= ueber <= UNTERSCHRIFT_ABSTAND:
            return ("ueber", max(0.0, ueber))
    if iy >= 0.5 * min(hoehe, img.y1 - img.y0):
        neben = max(x0 - img.x1, img.x0 - x1)
        if -0.02 <= neben <= UNTERSCHRIFT_ABSTAND:
            return ("neben", max(0.0, neben))
    return None


def _umschlossen(kasten: Kasten, bilder: list[SourceImage]) -> list[SourceImage]:
    """Bilder, die ganz im Rahmen stehen: der Text laeuft um sie herum."""
    out = []
    for img in bilder:
        f = _flaeche(_bildkasten(img))
        if f > 0 and _schnitt(kasten, _bildkasten(img)) >= 0.8 * f:
            out.append(img)
    return out


@dataclass
class _Einheit:
    """Ein Stueck Unterschrift: eine Story auf einer Seite, oder eine ihrer Gruppen."""

    seite: int
    kasten: Kasten
    text: str


def _unterschrift_rahmen(blocks: list[SourceBlock]) -> list[tuple[Kasten, list[list[SourceBlock]]]]:
    """Je Rahmen einer Unterschriften-Story: der Rahmen und seine Absatzgruppen."""
    je_rahmen: dict[tuple, list[SourceBlock]] = defaultdict(list)
    for b in blocks:
        kasten = b.frame_box or (b.x0, b.y0, b.x1, b.y1)
        je_rahmen[(b.page_index, b.frame_id or kasten, kasten)].append(b)
    out = []
    for (_seite, _kennung, kasten), liste in je_rahmen.items():
        gruppen: dict[int, list[SourceBlock]] = defaultdict(list)
        for b in liste:
            gruppen[b.absatzgruppe].append(b)
        out.append((kasten, [gruppen[g] for g in sorted(gruppen)]))
    return out


def _gruppenkaesten(kasten: Kasten, gruppen: list[list[SourceBlock]]) -> list[Kasten]:
    """Die Lage jeder Absatzgruppe im Rahmen, nach ihrem Anteil am Text.

    Der Satz sagt nicht, wo eine Zeile steht; die Gruppen folgen aber von oben
    nach unten aufeinander, und ihr Textanteil ist ein gutes Mass fuer ihre
    Hoehe.
    """
    laengen = [max(1, sum(len(b.text) for b in g)) for g in gruppen]
    gesamt = sum(laengen)
    hoehe = kasten[3] - kasten[1]
    out = []
    vorher = 0
    for laenge in laengen:
        out.append(
            (
                kasten[0],
                kasten[1] + hoehe * vorher / gesamt,
                kasten[2],
                kasten[1] + hoehe * (vorher + laenge) / gesamt,
            )
        )
        vorher += laenge
    return out


def _beste_bilder(kasten: Kasten, bilder: list[SourceImage]) -> list[SourceImage]:
    """Das Bild, zu dem der Rahmen steht — oder mehrere nebeneinander.

    Steht eine Unterschrift unter zwei Bildern nebeneinander und reicht ueber
    beide ("Klaus Schwab (links) ... Brabeck-Letmathe (rechts)"), gehoert sie
    zu beiden.
    """
    bewertet = []
    for img in bilder:
        lage = _lage(kasten, img)
        if lage is None:
            continue
        art, abstand = lage
        bewertet.append(((abstand + UNTERSCHRIFT_ZUSCHLAG[art], _flaeche(_bildkasten(img))), img, art))
    if not bewertet:
        return []
    # Steht ein Bild im anderen (ein Ausschnitt im Aufmacher, das Foto auf dem
    # ganzseitigen Hintergrund), gilt die Unterschrift dem inneren.
    innere = [
        t for t in bewertet
        if not any(
            u[1] is not t[1]
            and _flaeche(_bildkasten(u[1])) < _flaeche(_bildkasten(t[1]))
            and _schnitt(_bildkasten(t[1]), _bildkasten(u[1])) >= 0.8 * _flaeche(_bildkasten(u[1]))
            for u in bewertet
        )
    ]
    bewertet = sorted(innere or bewertet, key=lambda t: t[0])
    (wert, _f), erstes, art = bewertet[0]
    out = [erstes]
    if art in ("unter", "ueber"):
        for (w, _f2), img, a in bewertet[1:]:
            if a != art or w - wert > 0.005:
                continue
            if _ueberdeckung(kasten[0], kasten[2], img.x0, img.x1) < 0.8 * (img.x1 - img.x0):
                continue
            if any(_ueberdeckung(img.x0, img.x1, o.x0, o.x1) > 0 for o in out):
                continue
            out.append(img)
    return out


def unterschriften_zuordnen(images: list[SourceImage], blocks: list[SourceBlock]) -> int:
    """Jedem Bild seine Unterschrift aus dem Satz; liefert die Zahl der Bilder mit Unterschrift.

    Gesucht wird je Rahmen einer Unterschriften-Story (Absatzformat
    "Bildunterschrift ...", "Bildtext", "Legende") das Bild, zu dem er steht:
    umschliesst der Rahmen ein Bild (ein Kasten mit Foto, um das der Text
    laeuft), gehoert er zu diesem; sonst das naechste Bild, unter dem er
    steht, in dem er steht (weisse Schrift auf dem Foto), darueber oder
    daneben. Ein Rahmen zwischen zwei Bildern mit zwei durch eine Leerzeile
    getrennten Absatzgruppen gibt die obere Gruppe dem oberen, die untere dem
    unteren Bild. Mehrere Stuecke fuer ein Bild werden in Leserichtung
    verbunden. Eine schon vorhandene Unterschrift wird ersetzt: sie kam aus
    der Schaetzung ueber Schriftgroessen.
    """
    rollen = {s.story_id: s.rolle() for s in stories_bilden(blocks)}
    unterschriften = [
        b
        for b in blocks
        if b.origin == "idml" and rollen.get(b.story_id or "") == "bildunterschrift" and b.text.strip()
    ]
    je_seite_bilder: dict[int, list[SourceImage]] = defaultdict(list)
    for img in images:
        je_seite_bilder[img.page_index].append(img)

    je_story: dict[tuple[int, str], list[SourceBlock]] = defaultdict(list)
    for b in unterschriften:
        je_story[(b.page_index, b.story_id or "")].append(b)

    stuecke: dict[int, list[tuple[float, float, str]]] = defaultdict(list)
    bild_nach_id = {id(i): i for i in images}
    for (seite, _story), liste in je_story.items():
        bilder = je_seite_bilder.get(seite, [])
        if not bilder:
            continue
        for kasten, gruppen in _unterschrift_rahmen(liste):
            ganz = zeilen_verbinden(b.text for g in gruppen for b in g)
            drin = _umschlossen(kasten, bilder)
            if drin:
                ziel = max(drin, key=lambda i: _flaeche(_bildkasten(i)))
                stuecke[id(ziel)].append((kasten[1], kasten[0], ganz))
                continue
            if len(gruppen) >= 2:
                darueber = [
                    i for i in bilder
                    if (l := _lage(kasten, i)) is not None and l[0] == "unter"
                ]
                darunter = [
                    i for i in bilder
                    if (l := _lage(kasten, i)) is not None and l[0] == "ueber"
                ]
                if darueber and darunter:
                    oben = min(darueber, key=lambda i: abs(kasten[1] - i.y1))
                    unten = min(darunter, key=lambda i: abs(i.y0 - kasten[3]))
                    if oben is not unten:
                        for g, gk in zip(gruppen, _gruppenkaesten(kasten, gruppen)):
                            zu_oben = abs(gk[1] - oben.y1) <= abs(unten.y0 - gk[3])
                            ziel = oben if zu_oben else unten
                            stuecke[id(ziel)].append(
                                (gk[1], gk[0], zeilen_verbinden(b.text for b in g))
                            )
                        continue
            for ziel in _beste_bilder(kasten, bilder):
                stuecke[id(ziel)].append((kasten[1], kasten[0], ganz))

    mit = 0
    for kennung, liste in stuecke.items():
        texte = [t for _y, _x, t in sorted(liste) if t and not _NACHWEIS.match(t)]
        if not texte:
            continue
        img = bild_nach_id[kennung]
        img.caption = " ".join(texte)[:UNTERSCHRIFT_HOECHSTLAENGE]
        mit += 1
    for img in images:
        img.satz_geprueft = True
    return mit


# --- 2. Belege -------------------------------------------------------------------

# Der Bildnachweis steht am Rand des Bildes, oft quer gestellt.
BELEG_RAND = 0.025
_ANZEIGE_MARKE = re.compile(r"^\s*anzeigen?\s*$", re.I)
_SEITENNACHWEIS = re.compile(r"\b(?:alle|s[aä]mtliche)\s+(?:fotos|bilder|abbildungen)\b[^:]{0,30}(?:seite|seiten)\b", re.I)


def _kurze_texte(blocks: list[SourceBlock], hoechstens: int = 160) -> list[tuple[Story, str]]:
    out = []
    for s in stories_bilden(blocks):
        t = _text(s)
        if t and len(t) <= hoechstens:
            out.append((s, t))
    return out


def _rahmen_der_story(story: Story) -> list[tuple[int, Kasten]]:
    gesehen: dict[tuple, tuple[int, Kasten]] = {}
    for b in story.blocks:
        kasten = b.frame_box or (b.x0, b.y0, b.x1, b.y1)
        gesehen[(b.page_index, b.frame_id or kasten)] = (b.page_index, kasten)
    return list(gesehen.values())


def _am_rand(kasten: Kasten, img: SourceImage, rand: float = BELEG_RAND) -> bool:
    gross = (img.x0 - rand, img.y0 - rand, img.x1 + rand, img.y1 + rand)
    f = _flaeche(kasten)
    return f > 0 and _schnitt(kasten, gross) >= 0.5 * f


def belege_setzen(images: list[SourceImage], blocks: list[SourceBlock]) -> None:
    """Redaktionelle Bilder an Unterschrift oder Bildnachweis erkennen."""
    nachweise: list[tuple[int, Kasten]] = []
    ganze_seiten: set[int] = set()
    for story, text in _kurze_texte(blocks):
        if _SEITENNACHWEIS.search(text):
            ganze_seiten.update(s for s, _k in _rahmen_der_story(story))
            continue
        if _NACHWEIS.match(text):
            nachweise.extend(_rahmen_der_story(story))
    for img in images:
        if img.caption:
            img.beleg = "unterschrift"
        elif img.page_index in ganze_seiten or any(
            seite == img.page_index and _am_rand(kasten, img) for seite, kasten in nachweise
        ):
            img.beleg = "quelle"


# --- 3. Schmuck ------------------------------------------------------------------

# Dieselbe Datei auf so vielen Seiten ist Seitenschmuck: Rubriksignet,
# Kalenderblatt, Stoerer. Ein Foto steht hoechstens im Verzeichnis und im
# Artikel, also auf zwei Seiten.
SCHMUCK_WIEDERHOLUNG = 3
# Ein Rahmen aus so vielen getrennten Umrissen ist ein Schriftzug in Umrissen.
SCHRIFTZUG_TEILPFADE = 3
# Ein Bild, so viel breiter als hoch (oder umgekehrt), ohne Unterschrift und
# Nachweis, ist ein Schriftzug oder eine Leiste.
STREIFEN_VERHAELTNIS = 4.0
# Ein Seitenverhaeltnis von A4, wenn die Seite keines mitbringt.
SEITE_BREITE_ZU_HOEHE = 210 / 297
# Die Grussformel am Ende eines Editorials; darunter steht die Unterschrift
# des Verfassers als Bild.
_GRUSSFORMEL = re.compile(r"\b(?:gr(?:ü|ue)(?:ß|ss)(?:e|en)|herzlich(?:st)?|ihr(?:e)?)\b[^.!?]{0,40}$", re.I)
GRUSS_HOECHSTLAENGE = 60
UNTERSCHRIFT_BILD_HOEHE = 0.12


def ohne_schriftzuege(frames: list) -> list:
    """Bildrahmen in Form eines Schriftzugs (Umrisse je Buchstabe) aussortieren."""
    return [f for f in frames if getattr(f, "teilpfade", 1) < SCHRIFTZUG_TEILPFADE]


def _stamm(link: str | None) -> str:
    return os.path.splitext(os.path.basename(link or ""))[0].strip().lower()


def _ist_fragment(img: SourceImage, bilder: list[SourceImage]) -> bool:
    """Ein freigestellter Ausschnitt ueber seinem eigenen Hintergrundbild.

    "X - frei.tif" liegt auf "X.tif": der Fluegel, der ueber die Textspalte
    ragt. Als eigenes Bild zeigt er nur ein Bruchstueck.
    """
    stamm = _stamm(img.link)
    if len(stamm) < 6:
        return False
    eigene = _flaeche(_bildkasten(img))
    for anderes in bilder:
        if anderes is img or anderes.page_index != img.page_index:
            continue
        grund = _stamm(anderes.link)
        if len(grund) < 6 or grund == stamm or not stamm.startswith(grund):
            continue
        if _flaeche(_bildkasten(anderes)) > eigene and _schnitt(
            _bildkasten(anderes), _bildkasten(img)
        ) >= 0.8 * eigene:
            return True
    return False


def _ist_streifen(img: SourceImage, breite_zu_hoehe: float) -> bool:
    b = (img.x1 - img.x0) * breite_zu_hoehe
    h = img.y1 - img.y0
    if b <= 0 or h <= 0:
        return False
    return max(b / h, h / b) >= STREIFEN_VERHAELTNIS


def _grussrahmen(blocks: list[SourceBlock]) -> list[tuple[int, Kasten]]:
    """Rahmen, in denen eine Story mit der Grussformel endet."""
    out = []
    for s in stories_bilden(blocks):
        if not s.blocks or s.rolle() != "mengentext":
            continue
        letzter = s.blocks[-1]
        if len(letzter.text) <= GRUSS_HOECHSTLAENGE and _GRUSSFORMEL.search(letzter.text.strip()):
            out.append((letzter.page_index, letzter.frame_box or (letzter.x0, letzter.y0, letzter.x1, letzter.y1)))
    return out


def _ist_unterschriftbild(img: SourceImage, gruesse: list[tuple[int, Kasten]]) -> bool:
    if img.y1 - img.y0 > UNTERSCHRIFT_BILD_HOEHE:
        return False
    for seite, kasten in gruesse:
        if seite != img.page_index:
            continue
        if _ueberdeckung(img.x0, img.x1, kasten[0], kasten[2]) < 0.5 * (img.x1 - img.x0):
            continue
        # Am unteren Ende des Rahmens oder knapp darunter.
        if kasten[1] + 0.5 * (kasten[3] - kasten[1]) <= img.y0 <= kasten[3] + UNTERSCHRIFT_ABSTAND:
            return True
    return False


# Ein Stoerer ("NEU!" im Stern): ein kurzes Wort ohne Absatzformat, das
# einen guten Teil des Bildes bedeckt.
STOERER_HOECHSTLAENGE = 20
STOERER_ANTEIL = 0.15


def _stoerertexte(blocks: list[SourceBlock]) -> list[tuple[int, Kasten]]:
    out = []
    for s in stories_bilden(blocks):
        if s.rolle() != "beiwerk":
            continue
        t = _text(s)
        if 0 < len(t) <= STOERER_HOECHSTLAENGE:
            out.extend(_rahmen_der_story(s))
    return out


def _ist_stoerer(img: SourceImage, texte: list[tuple[int, Kasten]]) -> bool:
    f = _flaeche(_bildkasten(img))
    if f <= 0:
        return False
    for seite, k in texte:
        if seite != img.page_index:
            continue
        drin = _schnitt(k, _bildkasten(img))
        if drin >= 0.8 * _flaeche(k) and drin >= STOERER_ANTEIL * f:
            return True
    return False


def ohne_schmuck(
    images: list[SourceImage],
    blocks: list[SourceBlock],
    breite_zu_hoehe: dict[int, float] | None = None,
) -> tuple[list[SourceImage], dict[str, int]]:
    """Seitenschmuck, Fragmente und Schriftzuege aus den Bildern nehmen.

    Liefert die uebrigen Bilder und je Grund die Zahl der entfernten. Erst
    nach `unterschriften_zuordnen` und `belege_setzen` aufrufen: ein Bild mit
    Unterschrift oder Nachweis ist nie ein Streifen und nie eine Unterschrift
    des Verfassers.
    """
    seiten_je_datei: dict[str, set[int]] = defaultdict(set)
    beschriftet: set[str] = set()
    for img in images:
        if img.link:
            seiten_je_datei[_stamm(img.link)].add(img.page_index)
            if img.caption:
                beschriftet.add(_stamm(img.link))
    gruesse = _grussrahmen(blocks)
    stoerer = _stoerertexte(blocks)
    bleiben: list[SourceImage] = []
    grund: dict[str, int] = defaultdict(int)
    for img in images:
        stamm = _stamm(img.link)
        ohne_beleg = not img.caption and not img.beleg
        if stamm and len(seiten_je_datei[stamm]) >= SCHMUCK_WIEDERHOLUNG and stamm not in beschriftet:
            grund["wiederholt"] += 1
            continue
        if _ist_fragment(img, images):
            grund["fragment"] += 1
            continue
        verhaeltnis = (breite_zu_hoehe or {}).get(img.page_index, SEITE_BREITE_ZU_HOEHE)
        if ohne_beleg and _ist_streifen(img, verhaeltnis):
            grund["streifen"] += 1
            continue
        if ohne_beleg and _ist_unterschriftbild(img, gruesse):
            grund["unterschrift"] += 1
            continue
        if ohne_beleg and _ist_stoerer(img, stoerer):
            grund["stoerer"] += 1
            continue
        bleiben.append(img)
    return bleiben, dict(grund)


# --- 4. Anzeigen -----------------------------------------------------------------

# Beruehrung: so weit duerfen Teile einer Anzeige auseinanderstehen. Weniger
# als ein Spaltenzwischenraum (2,4 % in ZUERST!), damit eine Anzeige nicht in
# die Nachbarspalte waechst.
ANZEIGE_BERUEHRUNG = 0.02
# Kurze Texte, die zu einer Anzeige gehoeren koennen (Bestellzeile, Preis,
# Werbesatz). Laengeres ist Lesetext.
ANZEIGE_TEXT_HOECHSTENS = 400
# Eine Buchanzeige ist kurz; eine Besprechung nennt hinter dem Preis Verlag und
# Jahr ("€ 24,–. Dresden: Jungeuropa Verlag, 2025.").
ANZEIGE_HOECHSTZEICHEN = 2500
_BESPRECHUNG = re.compile(r"\b(?:1[89]|20)\d\d\.?\s*$")
_WEBADRESSE = re.compile(r"\bwww\.\S+|\b[\w-]+\.(?:de|com|org|net|eu|at|ch)\b|\bt\.me/\S+", re.I)
# Rollen, die nie Teil einer Anzeige sind: Kopf und Kasten eines Artikels.
# Eine Verfasserzeile kann es sein ("Autorenname Katalog" ueber der
# Beschreibung); dann ist sie nie der Autor des Artikels nebenan.
_NIE_ANZEIGE = ("ueberschrift", "unterzeile", "einleitung", "kasten", "bildunterschrift", "schmuckzitat", "verzeichnis", "fussnote")


def ist_anzeigentext(text: str) -> bool:
    """Eine Buchanzeige als Text: Preis mit Umfang oder Artikelnummer, keine Besprechung."""
    t = " ".join(text.split())
    if not t or len(t) > ANZEIGE_HOECHSTZEICHEN or not ist_buchanzeige(t):
        return False
    return not _BESPRECHUNG.search(t[-60:])


# Die Preiszeile einer Anzeige steht oft in einem eigenen kleinen Rahmen
# ("€ 32,80" rechts unter der Beschreibung).
ANZEIGE_ZEILE = 120


def _anzeigen_ids(stories: list[Story]) -> set[str]:
    """Die Stories, die eine Buchanzeige sind.

    Eine Beschreibung mit Umfang ist eine Anzeige, wenn sie selbst den Preis
    nennt — oder eine kurze Zeile, die an ihren Rahmen stoesst ("€ 32,80").
    """
    kurz = [
        (s, _text(s), _rahmen_der_story(s))
        for s in stories
        if 0 < s.textzeichen <= ANZEIGE_ZEILE
    ]
    out: set[str] = set()
    for s in stories:
        if s.rolle() != "mengentext":
            continue
        t = _text(s)
        if len(t) > ANZEIGE_HOECHSTZEICHEN:
            continue
        if ist_anzeigentext(t):
            out.add(s.story_id)
            continue
        rahmen = _rahmen_der_story(s)
        zusatz = [
            kt
            for k, kt, kr in kurz
            if k is not s
            and any(
                sa == sb and _abstand(ka, kb) <= ANZEIGE_BERUEHRUNG
                for sa, ka in rahmen
                for sb, kb in kr
            )
        ]
        if zusatz and ist_anzeigentext(f"{t} {' '.join(zusatz)}"):
            out.add(s.story_id)
    return out


def anzeigen_stories(blocks: list[SourceBlock]) -> set[str]:
    """Die Stories, die als Buchanzeige eigene Artikel werden."""
    return _anzeigen_ids(stories_bilden(blocks))


@dataclass
class _Teil:
    """Ein Element einer moeglichen Anzeige: Bild, kurzer Text oder Anzeigentext."""

    seite: int
    kaesten: list[Kasten]
    bild: SourceImage | None = None
    story: Story | None = None
    saat: bool = False
    nachbarn: list[int] = field(default_factory=list)


def _beruehrt(a: _Teil, b: _Teil) -> bool:
    return a.seite == b.seite and any(
        _abstand(ka, kb) <= ANZEIGE_BERUEHRUNG for ka in a.kaesten for kb in b.kaesten
    )


def anzeigen_erkennen(
    images: list[SourceImage], blocks: list[SourceBlock]
) -> dict[str, list[str]]:
    """Anzeigen auf den Seiten finden; markiert ihre Bilder und Texte.

    Ausgangspunkte (aus dem Heft belegt):

    * ein Bild, neben dem die Kennzeichnung "Anzeige" steht;
    * ein platziertes PDF ohne Unterschrift und Nachweis — so liefern
      Inserenten ihre Anzeigen;
    * eine Buchanzeige als Text (`ist_anzeigentext`) oder ein kurzer Text mit
      Preis und Bestellangaben (`anzeige.ist_anzeige`).

    Dazu kommt, was ohne redaktionellen Beleg daran stoesst: Umschlagbilder,
    Bestellzeilen, Werbesaetze. Eine Gruppe kurzer Texte und Bilder, die
    zusammen Preise und Anschrift nennen (das Kalenderprogramm) oder mehrere
    Webadressen (die Eigenwerbung in "Zuletzt"), ist ebenso eine Anzeige.

    Bilder einer Anzeige bekommen `anzeige`; gehoert die Anzeige zu einer
    Buchanzeige mit eigenem Artikel, auch deren `story_id`. Kurze Texte einer
    Anzeige ohne eigenen Artikel werden `drop`: sie gehoeren in keinen
    Artikel. Liefert je Anzeigen-Story die Seiten-Kennungen ihrer Teile (fuer
    Klickflaechen und Pruefung).
    """
    stories = stories_bilden(blocks)
    texte = {s.story_id: _text(s) for s in stories}
    anzeigen_ids = _anzeigen_ids(stories)
    teile: list[_Teil] = []
    marken: list[tuple[int, Kasten]] = []
    for s in stories:
        t = texte[s.story_id]
        if _ANZEIGE_MARKE.match(t):
            marken.extend(_rahmen_der_story(s))
            continue
        rolle = s.rolle()
        if s.story_id in anzeigen_ids:
            je_seite: dict[int, list[Kasten]] = defaultdict(list)
            for seite, k in _rahmen_der_story(s):
                je_seite[seite].append(k)
            for seite, ks in je_seite.items():
                teile.append(_Teil(seite, ks, story=s, saat=True))
            continue
        if rolle in _NIE_ANZEIGE or len(t) > ANZEIGE_TEXT_HOECHSTENS or _NACHWEIS.match(t):
            continue
        if rolle == "mengentext" and s.textzeichen >= ARTIKEL_MINDESTZEICHEN:
            continue
        je_seite = defaultdict(list)
        for seite, k in _rahmen_der_story(s):
            je_seite[seite].append(k)
        for seite, ks in je_seite.items():
            teile.append(_Teil(seite, ks, story=s, saat=ist_anzeige(t)))
    for img in images:
        if img.caption or img.beleg:
            continue
        markiert = any(
            seite == img.page_index and _abstand(k, _bildkasten(img)) <= UNTERSCHRIFT_ABSTAND
            for seite, k in marken
        )
        pdf = (img.link or "").lower().endswith(".pdf")
        teile.append(_Teil(img.page_index, [_bildkasten(img)], bild=img, saat=markiert or pdf))

    # Zusammenhaengende Gruppen je Seite.
    je_seite_teile: dict[int, list[int]] = defaultdict(list)
    for i, t in enumerate(teile):
        je_seite_teile[t.seite].append(i)
    gruppe_von: dict[int, int] = {}
    gruppen: list[list[int]] = []
    for seite, nummern in je_seite_teile.items():
        for start in nummern:
            if start in gruppe_von:
                continue
            gruppe = [start]
            gruppe_von[start] = len(gruppen)
            offen = [start]
            while offen:
                i = offen.pop()
                for j in nummern:
                    if j not in gruppe_von and _beruehrt(teile[i], teile[j]):
                        gruppe_von[j] = len(gruppen)
                        gruppe.append(j)
                        offen.append(j)
            gruppen.append(gruppe)

    ergebnis: dict[str, list[str]] = defaultdict(list)
    for gruppe in gruppen:
        mitglieder = [teile[i] for i in gruppe]
        text = " ".join(texte[t.story.story_id] for t in mitglieder if t.story is not None)
        ist = (
            any(t.saat for t in mitglieder)
            or ist_anzeige(text)
            or len(set(m.lower() for m in _WEBADRESSE.findall(text))) >= 2
        )
        if not ist:
            continue
        anzeigen = [t for t in mitglieder if t.story is not None and t.story.story_id in anzeigen_ids]
        einzige = {t.story.story_id for t in anzeigen}
        for t in mitglieder:
            if t.bild is not None:
                t.bild.anzeige = True
                if len(einzige) == 1:
                    # Eine Anzeige allein: alles, was an ihr haengt, zeigt sie.
                    ziel = next(iter(einzige))
                else:
                    ziel = _anzeige_des_bildes(t.bild, anzeigen) if anzeigen else None
                t.bild.story_id = ziel
                if ziel:
                    ergebnis[ziel].append(f"bild:{t.seite}")
        for t in mitglieder:
            if t.bild is not None or t.story is None or t.story.story_id in anzeigen_ids:
                continue
            if t.story.rolle() not in ("mengentext", "autor"):
                continue
            # Preiszeile, Verfasser oder Stoerer ("5 Bände im Schuber") in
            # eigenem Rahmen gehoeren ans Ende der Anzeige, an der sie stehen;
            # Bestellzeile, Werbesatz und Eigenwerbung in keinen Artikel.
            ziel = (
                next(iter(einzige))
                if len(einzige) == 1
                else _naechste_anzeige(t, mitglieder, anzeigen_ids)
            )
            letzter = next(
                (b for b in reversed(blocks) if ziel and b.story_id == ziel), None
            )
            for b in t.story.blocks:
                if b.page_index != t.seite:
                    continue
                if letzter is not None:
                    # Die Zeile wird Teil der Anzeige: ihre Story, ihr Rahmen,
                    # ihre Stelle hinter dem letzten Absatz. So bleibt der
                    # Umriss der Anzeige, wie der Satz ihn setzt.
                    b.story_id = letzter.story_id
                    b.frame_id = letzter.frame_id
                    b.frame_box = letzter.frame_box
                    b.page_index = letzter.page_index
                    b.x0, b.x1 = letzter.x0, letzter.x1
                    b.y0 = b.y1 = letzter.y1
                    blocks.remove(b)
                    blocks.append(b)
                else:
                    b.drop = True
    return dict(ergebnis)


def _naechste_anzeige(teil: _Teil, mitglieder: list[_Teil], anzeigen_ids: set[str]) -> str | None:
    """Die Anzeige des naechsten Nachbarn: ihr Text oder ihr Umschlagbild."""
    beste: tuple[float, str] | None = None
    for m in mitglieder:
        if m is teil:
            continue
        if m.bild is not None:
            ziel = m.bild.story_id
        elif m.story is not None and m.story.story_id in anzeigen_ids:
            ziel = m.story.story_id
        else:
            ziel = None
        if not ziel:
            continue
        abstand = min(_abstand(a, b) for a in teil.kaesten for b in m.kaesten)
        if abstand <= ANZEIGE_BERUEHRUNG and (beste is None or abstand < beste[0]):
            beste = (abstand, ziel)
    return beste[1] if beste else None


def _anzeige_des_bildes(img: SourceImage, anzeigen: list[_Teil]) -> str | None:
    """Welche Buchanzeige zeigt dieses Umschlagbild?

    Das Bild steht im Rahmen der Anzeige (der Text laeuft darum herum), direkt
    darueber in derselben Spalte oder daneben in derselben Zeile; nie darunter
    — dort beginnt die naechste Anzeige. Nennt der Dateiname den Titel, zaehlt
    das mehr als die Lage.
    """
    from .buecher import _bild_passt_zum_titel, _kopf_der_kachel

    beste: tuple[float, str] | None = None
    for t in anzeigen:
        story = t.story
        assert story is not None
        _autor, titel = _kopf_der_kachel([b for b in story.blocks if b.page_index == t.seite])
        name = _bild_passt_zum_titel(img, titel) if titel else 0.0
        lage = 0.0
        for k in t.kaesten:
            breite = min(img.x1 - img.x0, k[2] - k[0])
            hoehe = min(img.y1 - img.y0, k[3] - k[1])
            f = _flaeche(_bildkasten(img))
            if f > 0 and _schnitt(k, _bildkasten(img)) >= 0.5 * f:
                lage = max(lage, 1.5)
                continue
            spalte = breite > 0 and _ueberdeckung(img.x0, img.x1, k[0], k[2]) >= 0.5 * breite
            zeile = hoehe > 0 and _ueberdeckung(img.y0, img.y1, k[1], k[3]) >= 0.5 * hoehe
            ueber = k[1] - img.y1
            neben = max(k[0] - img.x1, img.x0 - k[2])
            if spalte and -0.02 <= ueber <= 0.06:
                lage = max(lage, 1.0 - ueber)
            elif zeile and -0.02 <= neben <= 0.05:
                lage = max(lage, 0.8 - neben)
        punkte = name * 2 + lage
        if (lage > 0 or name >= 0.6) and (beste is None or punkte > beste[0]):
            beste = (punkte, story.story_id)
    return beste[1] if beste else None


# --- 5. Zugehoerigkeit -----------------------------------------------------------

# Ab diesem Anteil steht ein Bild im Rahmen einer Story (Text laeuft darum).
IM_RAHMEN = 0.5
# Weiter als so (Anteil der Seitenhoehe) hat ein Text in der Spalte nichts
# mehr mit dem Bild zu tun.
SPALTEN_NAEHE = 0.22
ZEILEN_NAEHE = 0.05
# Rollen, deren Rahmen ein Bild an sich binden: der Text eines Artikels und
# seine Kaesten.
_TEXT_ROLLEN = ("mengentext", "kasten")


def stories_zuordnen(
    images: list[SourceImage],
    blocks: list[SourceBlock],
    textrahmen: list | None = None,
) -> None:
    """Jedem redaktionellen Bild die Text-Story, zu der es gehoert.

    In der Reihenfolge: die Story, in deren Rahmen das Bild steht (stehen
    mehrere Rahmen darum, der kleinste — die Buchanzeige im Rahmen, um den der
    Text der Seite herumlaeuft); sonst die Story, an deren Rahmen es in
    derselben Spalte am naechsten stoesst; sonst die in derselben Zeile
    daneben. Gemessen wird an allen Rahmen der Story auf der Seite
    (`textrahmen`), auch an einem, in den die Schaetzung keinen Absatz gelegt
    hat. Anzeigen sind fuer redaktionelle Bilder tabu. Findet sich nichts,
    bleibt `story_id` leer und der Artikelaufbau entscheidet wie bisher.
    """
    rollen = {s.story_id: s.rolle() for s in stories_bilden(blocks)}
    anzeigen = anzeigen_stories(blocks)
    zeichen: dict[tuple[int, str], int] = defaultdict(int)
    for b in blocks:
        if b.story_id:
            zeichen[(b.page_index, b.story_id)] += len(b.text)
    rahmen: dict[int, list[tuple[str, Kasten]]] = defaultdict(list)
    if textrahmen is not None:
        for f in textrahmen:
            if rollen.get(f.story_id) in _TEXT_ROLLEN:
                rahmen[f.page_number].append((f.story_id, (f.x0, f.y0, f.x1, f.y1)))
    else:
        gesehen = set()
        for b in blocks:
            if not b.story_id or rollen.get(b.story_id) not in _TEXT_ROLLEN:
                continue
            k = b.frame_box or (b.x0, b.y0, b.x1, b.y1)
            if (b.page_index, b.story_id, k) not in gesehen:
                gesehen.add((b.page_index, b.story_id, k))
                rahmen[b.page_index].append((b.story_id, k))

    for img in images:
        if img.anzeige:
            continue
        kasten = _bildkasten(img)
        f = _flaeche(kasten)
        if f <= 0:
            continue
        je_story: dict[str, list[Kasten]] = defaultdict(list)
        for story_id, k in rahmen.get(img.page_index, []):
            # Ein Foto mit Unterschrift oder Nachweis gehoert nie zu einer
            # Anzeige, auch wenn es an sie stoesst.
            if img.beleg and story_id in anzeigen:
                continue
            je_story[story_id].append(k)
        if not je_story:
            continue
        im: list[tuple[float, str]] = []
        spalte: list[tuple[float, float, str]] = []
        zeile: list[tuple[float, float, str]] = []
        for story_id, ks in je_story.items():
            anteil = sum(_schnitt(k, kasten) for k in ks) / f
            menge = zeichen.get((img.page_index, story_id), 0)
            if anteil >= IM_RAHMEN:
                im.append((sum(_flaeche(k) for k in ks), story_id))
                continue
            for k in ks:
                breite = min(img.x1 - img.x0, k[2] - k[0])
                hoehe = min(img.y1 - img.y0, k[3] - k[1])
                if breite > 0 and _ueberdeckung(img.x0, img.x1, k[0], k[2]) >= 0.5 * breite:
                    abstand = max(0.0, k[1] - img.y1, img.y0 - k[3])
                    if abstand <= SPALTEN_NAEHE:
                        spalte.append((abstand, -menge, story_id))
                elif hoehe > 0 and _ueberdeckung(img.y0, img.y1, k[1], k[3]) >= 0.5 * hoehe:
                    abstand = max(0.0, k[0] - img.x1, img.x0 - k[2])
                    if abstand <= ZEILEN_NAEHE:
                        zeile.append((abstand, -menge, story_id))
        if im:
            img.story_id = min(im)[1]
        elif spalte:
            img.story_id = min(spalte)[2]
        elif zeile:
            img.story_id = min(zeile)[2]
    _bildseiten_zuordnen(images, rollen, anzeigen, rahmen)


def _bildseiten_zuordnen(
    images: list[SourceImage],
    rollen: dict[str, str],
    anzeigen: set[str],
    rahmen: dict[int, list[tuple[str, Kasten]]],
) -> None:
    """Fotos auf einer Seite ohne Text gehoeren zu der Story, die um sie herumlaeuft.

    Eine Bildseite mitten im Artikel (acht Fotos mit Unterschriften, kein
    Textrahmen) hat keinen Nachbarn auf der Seite. Laeuft die Rahmenkette
    einer Story ueber die Seiten davor und danach, ist es ihre. Nur Fotos mit
    Unterschrift oder Nachweis: eine ganzseitige Anzeige zwischen zwei
    Artikelseiten bleibt draussen.
    """
    spanne: dict[str, tuple[int, int]] = {}
    for seite, liste in rahmen.items():
        for story_id, _k in liste:
            if rollen.get(story_id) != "mengentext" or story_id in anzeigen:
                continue
            a, b = spanne.get(story_id, (seite, seite))
            spanne[story_id] = (min(a, seite), max(b, seite))
    for img in images:
        if img.story_id or img.anzeige or not img.beleg or rahmen.get(img.page_index):
            continue
        umfassend = [
            (b - a, story_id)
            for story_id, (a, b) in spanne.items()
            if a < img.page_index < b
        ]
        if umfassend:
            img.story_id = min(umfassend)[1]


def bilder_im_satz(
    images: list[SourceImage],
    blocks: list[SourceBlock],
    textrahmen: list | None = None,
    breite_zu_hoehe: dict[int, float] | None = None,
) -> tuple[list[SourceImage], dict]:
    """Alle Schritte in ihrer Reihenfolge; liefert die Bilder und eine Bilanz."""
    mit = unterschriften_zuordnen(images, blocks)
    belege_setzen(images, blocks)
    bleiben, schmuck = ohne_schmuck(images, blocks, breite_zu_hoehe)
    anzeigen = anzeigen_erkennen(bleiben, blocks)
    stories_zuordnen(bleiben, blocks, textrahmen)
    bilanz = {
        "bilder": len(images),
        "mitUnterschrift": mit,
        "schmuck": schmuck,
        "anzeigenbilder": sum(1 for i in bleiben if i.anzeige),
        "anzeigen": len(anzeigen),
        "mitStory": sum(1 for i in bleiben if i.story_id),
    }
    return bleiben, bilanz


def bilder_verteilen(artikel: list, images: list[SourceImage], stories: list[Story]) -> None:
    """Die Bilder auf die fertigen Artikel legen.

    Ein Bild mit Story kommt in den Artikel, der diese Story traegt. Ein Bild
    einer Anzeige ohne eigenen Artikel kommt nirgends hin. Was der Satz nicht
    zuordnen konnte (ein Aufmacherbild auf einer Seite ohne Text), entscheidet
    die Lage wie beim PDF (`article_assembler._attach_images`) — ein Foto mit
    Unterschrift oder Nachweis dabei nur unter den redaktionellen Artikeln.
    """
    from .article_assembler import MAX_IMAGES_PER_ARTICLE, _attach_images

    # Die Preiszeile einer Anzeige ist hier schon fort (sie gehoert in keinen
    # Artikel); was Anzeige ist, steht deshalb auch an ihren Bildern.
    anzeigen = _anzeigen_ids(stories) | {
        i.story_id for i in images if i.anzeige and i.story_id
    }
    artikel_der_story: dict[str, object] = {}
    for a in artikel:
        for b in a.blocks:
            if b.story_id:
                artikel_der_story.setdefault(b.story_id, a)
    anzeigen_artikel = {
        id(a) for a in artikel if any(b.story_id in anzeigen for b in a.blocks if b.story_id)
    }
    redaktionell_rest: list[SourceImage] = []
    rest: list[SourceImage] = []
    for img in images:
        if not img.satz_geprueft:
            rest.append(img)
            continue
        ziel = artikel_der_story.get(img.story_id or "")
        if ziel is not None:
            if len(ziel.images) < MAX_IMAGES_PER_ARTICLE:
                ziel.images.append(img)
            continue
        if img.anzeige:
            continue
        (redaktionell_rest if img.beleg else rest).append(img)
    _attach_images([a for a in artikel if id(a) not in anzeigen_artikel], redaktionell_rest)
    _attach_images(artikel, rest)


def ist_anzeigenartikel(article, anzeigen: set[str]) -> bool:
    """Ein Artikel, der eine Anzeige ist: seine Story oder seine Bilder sagen es."""
    return any(b.story_id in anzeigen for b in article.blocks if b.story_id) or any(
        getattr(i, "anzeige", False) for i in article.images
    )


# --- Klickflaechen -----------------------------------------------------------------


def _flaeche_als_region(seite: int, k: Kasten, **extra) -> dict:
    return {
        "pageIndex": seite,
        "x0": round(max(0.0, k[0]), 5),
        "y0": round(max(0.0, k[1]), 5),
        "x1": round(min(1.0, k[2]), 5),
        "y1": round(min(1.0, k[3]), 5),
        "kind": "other",
        **extra,
    }


def anzeigenflaechen(blocks: list[SourceBlock], images: list[SourceImage]) -> list[dict]:
    """Je Seite eine Klickflaeche ueber die ganze Anzeige.

    Beschreibung, Titelzeilen, Preiszeile und Umschlagbilder einer Anzeige
    liegen nebeneinander; dazwischen bliebe ein Tipp ohne Wirkung. Der Leser
    nimmt bei uebereinanderliegenden Flaechen die kleinste — eine
    Nachbaranzeige mit eigener Flaeche verliert also nichts.
    """
    je_seite: dict[int, list[Kasten]] = defaultdict(list)
    for b in blocks:
        je_seite[b.page_index].append(b.frame_box or (b.x0, b.y0, b.x1, b.y1))
    for img in images:
        je_seite[img.page_index].append(_bildkasten(img))
    out = []
    for seite, ks in sorted(je_seite.items()):
        umriss = (
            min(k[0] for k in ks),
            min(k[1] for k in ks),
            max(k[2] for k in ks),
            max(k[3] for k in ks),
        )
        out.append(_flaeche_als_region(seite, umriss))
    return out


def teaserflaechen(
    verzeichnis_bilder: list[SourceImage],
    artikel_bilder: list[tuple[int, int, list[SourceImage]]],
) -> list[tuple[int, dict]]:
    """Bild-Anreisser im gedruckten Verzeichnis: eine Flaeche zum Artikel des Bildes.

    Das Verzeichnis zeigt ein Bild des Artikels noch einmal, mit derselben
    Datei aus `Links/`. Daran ist der Artikel sicher zu erkennen; ein Tipp auf
    das Bild springt auf seine erste Seite wie eine Zeile des Verzeichnisses.
    `artikel_bilder`: je Artikel (Nummer ab 1, erste Seite, Bilder). Geliefert
    wird (Artikelnummer, Flaeche).
    """
    je_datei: dict[str, tuple[int, int]] = {}
    for nummer, erste_seite, bilder in artikel_bilder:
        for img in bilder:
            stamm = _stamm(img.link)
            if stamm:
                je_datei.setdefault(stamm, (nummer, erste_seite))
    out = []
    for img in verzeichnis_bilder:
        treffer = je_datei.get(_stamm(img.link))
        if treffer is None or treffer[1] == img.page_index:
            continue
        nummer, erste_seite = treffer
        out.append(
            (nummer, _flaeche_als_region(img.page_index, _bildkasten(img), targetPageIndex=erste_seite))
        )
    return out
