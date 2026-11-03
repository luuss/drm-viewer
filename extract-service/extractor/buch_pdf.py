"""Ein Heft als ein durchgehender Text, nur aus dem PDF (Weltkrieg-Leser).

Die meisten Weltkrieg-Hefte gibt es nur als Druck-PDF, ohne IDML (316 von
448 im Archiv, 03.11.2026). Der Browser liest beim Import die Textebene
jeder Seite (Stuecke mit Lage und Schriftgroesse, `toc_layout.TextItem`);
das Druck-PDF bleibt auf dem Rechner. Daraus entsteht hier der Lesetext.

Die Hefte sind einfach gesetzt: ein- oder zweispaltig, eine Grundschrift,
Kapitelzeilen groesser, Fussnoten klein mit Sternchen, Initiale am
Kapitelanfang. Die Schritte je Seite:

1. Kolumnentitel und Seitenzahl am Kopf und Fuss der Seite fallen weg.
2. Spalten: Stuecke links und rechts der Seitenmitte, Breites (Kapitelzeile
   ueber beide Spalten) fuer sich.
3. Zeilen: Stuecke gleicher Hoehe in einer Spalte.
4. Initiale: ein einzelner sehr grosser Buchstabe gehoert vor die Zeile
   rechts daneben ("S" + "chon von weitem").
5. Absaetze: Einzug, groesserer Abstand oder eine kurze Zeile mit
   Satzende davor beginnen einen neuen.
6. Trennung: "Land-" + "ser" wird "Landser"; "Jäger-" + "Regiments" bleibt.

Der Text laeuft ueber die Seiten weiter: ein Absatz, der unten in der
rechten Spalte endet, setzt sich oben auf der naechsten Seite fort.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field

from .model import AssembledArticle, SourceBlock

# Kopf und Fuss der Seite: dort stehen Kolumnentitel und Seitenzahl.
KOPF_BIS = 0.115
FUSS_AB = 0.925
# Kolumnentitel und Seitenzahl sind kurz.
BEIWERK_HOECHSTLAENGE = 70
# Ein Stueck, das ueber diese Grenzen reicht, steht ueber beiden Spalten.
SPALTE_LINKS_BIS = 0.52
SPALTE_RECHTS_AB = 0.48
# Initiale: ein Buchstabe, mindestens so viel groesser als die Grundschrift.
INITIALE_FAKTOR = 2.0
# Kapitelzeile: groesser als die Grundschrift.
KAPITEL_FAKTOR = 1.25
KAPITEL_HOECHSTLAENGE = 120
# Fussnote und Bildunterschrift: kleiner als die Grundschrift.
KLEIN_FAKTOR = 0.85
FUSSNOTE = re.compile(r"^\s*\*")
SATZENDE = re.compile(r"[.!?…:“”\"»«)]\s*$")
TRENNER = re.compile(r"^[\s*·•⁂~–-]{1,12}$")


@dataclass
class _Zeile:
    seite: int
    spalte: int  # 0 links, 1 rechts, -1 ueber beide
    x0: float
    y0: float
    x1: float
    y1: float
    groesse: float
    teile: list[str] = field(default_factory=list)
    # Steht neben einer Initiale: eingerueckt, aber kein neuer Absatz.
    neben_initiale: bool = False
    # Erste Zeile neben der Initiale: hier beginnt ein Absatz.
    mit_initiale: bool = False

    @property
    def text(self) -> str:
        return _verbinden(self.teile)


def _verbinden(teile: list[str]) -> str:
    """Stuecke einer Zeile; ein einzelner Trennstrich haengt am Wort davor."""
    out = ""
    for t in teile:
        t = t.strip()
        if not t:
            continue
        if not out:
            out = t
        elif t in ("-", "‐", "­"):
            if not out.endswith("-"):
                out += "-"
        else:
            out += " " + t
    return out


def _grundschrift(seiten: dict[int, list]) -> float:
    zaehler: Counter[float] = Counter()
    for items in seiten.values():
        for i in items:
            if i.size > 0 and i.text.strip():
                zaehler[round(i.size, 1)] += len(i.text)
    return zaehler.most_common(1)[0][0] if zaehler else 0.0


def _ist_beiwerk(i, grund: float) -> bool:
    """Kolumnentitel und Seitenzahl: kurz, am Kopf oder Fuss, nicht groesser."""
    if len(i.text.strip()) > BEIWERK_HOECHSTLAENGE:
        return False
    if grund and i.size >= grund * KAPITEL_FAKTOR:
        return False
    return i.y1 <= KOPF_BIS or i.y0 >= FUSS_AB


def _spalte(i, zweispaltig: bool) -> int:
    if not zweispaltig:
        return 0
    if i.x0 < SPALTE_RECHTS_AB and i.x1 > SPALTE_LINKS_BIS:
        return -1
    return 1 if i.x0 >= SPALTE_RECHTS_AB else 0


def _zweispaltig(items: list) -> bool:
    links = sum(1 for i in items if i.x1 <= SPALTE_LINKS_BIS)
    rechts = sum(1 for i in items if i.x0 >= SPALTE_RECHTS_AB)
    return links >= 5 and rechts >= 5


def _zeilen(seite: int, items: list, grund: float) -> list[_Zeile]:
    items = [i for i in items if i.text.strip() and not _ist_beiwerk(i, grund)]
    if not items:
        return []
    zwei = _zweispaltig(items)
    # Initialen zuerst beiseite: sie sind mehrere Zeilen hoch.
    initialen = [
        i
        for i in items
        if grund and i.size >= grund * INITIALE_FAKTOR and len(i.text.strip()) == 1
    ]
    rest = [i for i in items if i not in initialen]
    rest.sort(key=lambda i: (_spalte(i, zwei), i.y0, i.x0))
    zeilen: list[_Zeile] = []
    for i in rest:
        sp = _spalte(i, zwei)
        hoehe = max(i.y1 - i.y0, 1e-4)
        z = next(
            (
                z
                for z in reversed(zeilen[-4:])
                if z.spalte == sp and abs(z.y0 - i.y0) < hoehe * 0.45
            ),
            None,
        )
        if z is None:
            zeilen.append(_Zeile(seite, sp, i.x0, i.y0, i.x1, i.y1, i.size, [i.text]))
        else:
            # Stuecke einer Zeile kommen nicht immer von links nach rechts.
            z.teile.append(i.text)
            z.x0, z.x1 = min(z.x0, i.x0), max(z.x1, i.x1)
            z.y1 = max(z.y1, i.y1)
            z.groesse = max(z.groesse, i.size)
    # Initiale vor die erste Zeile rechts neben ihr.
    for ini in initialen:
        neben = [
            z
            for z in zeilen
            if z.y0 >= ini.y0 - 0.01
            and z.y0 <= ini.y1
            # direkt rechts daneben, nicht in der naechsten Spalte
            and ini.x1 - 0.02 <= z.x0 <= ini.x1 + 0.03
        ]
        if neben:
            z = min(neben, key=lambda z: z.y0)
            z.teile[0] = ini.text.strip() + z.teile[0].lstrip()
            z.x0 = min(z.x0, ini.x0)
            z.mit_initiale = True
            for n in neben:
                if n is not z:
                    n.neben_initiale = True
    # Reihenfolge: Breites nach Hoehe dazwischen, sonst links vor rechts.
    breit = sorted((z for z in zeilen if z.spalte == -1), key=lambda z: z.y0)
    spalten = [sorted((z for z in zeilen if z.spalte == s), key=lambda z: z.y0) for s in (0, 1)]
    out: list[_Zeile] = []
    # Ein breites Stueck trennt die Seite in Baender; in jedem Band erst die
    # linke, dann die rechte Spalte.
    grenzen = [b.y0 for b in breit] + [2.0]
    oben = -1.0
    for n, grenze in enumerate(grenzen):
        for s in spalten:
            out.extend(z for z in s if oben <= z.y0 < grenze)
        if n < len(breit):
            out.append(breit[n])
            oben = breit[n].y0
    return out


def _absaetze(zeilen: list[_Zeile], grund: float) -> list[tuple[_Zeile, list[_Zeile]]]:
    """Zeilen zu Absaetzen; jeder Absatz mit seiner ersten Zeile."""
    # Linker Rand und Zeilenabstand je Seite und Spalte.
    rand: dict[tuple[int, int], float] = {}
    rechts: dict[tuple[int, int], float] = {}
    for z in zeilen:
        k = (z.seite, z.spalte)
        rand[k] = min(rand.get(k, 1.0), z.x0)
        rechts[k] = max(rechts.get(k, 0.0), z.x1)
    abstaende = [
        b.y0 - a.y0
        for a, b in zip(zeilen, zeilen[1:])
        if a.seite == b.seite and a.spalte == b.spalte and 0 < b.y0 - a.y0 < 0.05
    ]
    schritt = sorted(abstaende)[len(abstaende) // 2] if abstaende else 0.02
    out: list[tuple[_Zeile, list[_Zeile]]] = []
    vorige: _Zeile | None = None
    for z in zeilen:
        k = (z.seite, z.spalte)
        neu = vorige is None
        if not neu:
            gleiche_spalte = vorige.seite == z.seite and vorige.spalte == z.spalte
            klasse = _klasse(z, grund)
            if klasse != _klasse(vorige, grund):
                neu = True
            elif klasse != "text":
                # Kapitelzeilen ueber zwei Zeilen bleiben zusammen.
                neu = not gleiche_spalte or z.y0 - vorige.y0 > schritt * 2.2
            elif z.mit_initiale:
                neu = True
            elif z.neben_initiale:
                neu = False
            elif z.x0 > rand[k] + 0.012 and (
                vorige.x1 >= rechts[(vorige.seite, vorige.spalte)] - 0.06
                or SATZENDE.search(vorige.text)
            ):
                # Einzug nach voller Zeile oder Satzende. Zentrierte Zeilen
                # (Vorwort, Mahnung) sind auch eingerueckt, aber ohne das.
                neu = True
            elif gleiche_spalte and z.y0 - vorige.y0 > schritt * 1.6:
                neu = True  # Abstand
            else:
                vk = (vorige.seite, vorige.spalte)
                kurz = vorige.x1 < rechts[vk] - 0.06
                neu = kurz and bool(SATZENDE.search(vorige.text))
            if TRENNER.match(z.text) or TRENNER.match(vorige.text):
                neu = True
        if neu:
            out.append((z, [z]))
        else:
            out[-1][1].append(z)
        vorige = z
    return out


def _klasse(z: _Zeile, grund: float) -> str:
    if not grund:
        return "text"
    if z.groesse >= grund * KAPITEL_FAKTOR and len(z.text) <= KAPITEL_HOECHSTLAENGE:
        return "kapitel"
    if z.groesse <= grund * KLEIN_FAKTOR:
        return "klein"
    return "text"


def _ist_werbeseite(zeilen: list[_Zeile], grund: float) -> bool:
    """Eigenwerbung mitten im Heft ("Die neuen Hefte sind da!"): viele grosse
    Zeilen, kaum Grundschrift. Eine Kapitelseite hat eine grosse Zeile und
    darunter Text."""
    gross = sum(1 for z in zeilen if _klasse(z, grund) == "kapitel")
    text = sum(len(z.text) for z in zeilen if _klasse(z, grund) == "text")
    alles = sum(len(z.text) for z in zeilen) or 1
    return gross >= 5 or (gross >= 4 and text / alles < 0.5)


# Fehlt der Trennstrich in der Textebene (gezeichnet, aber nicht als Text),
# endet die Zeile um genau seine Breite vor dem Spaltenrand.
STRICH_LUECKE = (0.003, 0.016)


def _absatz_text(zeilen: list[_Zeile], rechts: dict[tuple[int, int], float] | None = None) -> str:
    out = ""
    vorige: _Zeile | None = None
    for z in zeilen:
        t = z.text.strip()
        if not out:
            out = t
            vorige = z
            continue
        rand = (rechts or {}).get((vorige.seite, vorige.spalte))
        luecke = rand - vorige.x1 if rand is not None else None
        vorige = z
        if (
            luecke is not None
            and STRICH_LUECKE[0] <= luecke <= STRICH_LUECKE[1]
            and re.search(r"[a-zäöüß]$", out)
            and t[:1].islower()
        ):
            out += t  # "Lie" + "gen" -> "Liegen"
            continue
        # Silbentrennung: "Land-" + "ser" -> "Landser". Ein Bindestrich vor
        # einem grossen Wort ("Jäger-" + "Regiments") bleibt.
        m = re.search(r"([A-Za-zÄÖÜäöüß])\s?-$", out)
        if m and t[:1].islower():
            out = out[: m.end(1)] + t
        elif m:
            out = out.rstrip()[:-1].rstrip() + "-" + t
        else:
            out += " " + t
    return re.sub(r"\s+", " ", out).strip()


def buch_aus_textebene(
    seiten: dict[int, list],
    ohne_seiten: set[int] | None = None,
    titel: str | None = None,
) -> list[AssembledArticle]:
    """Die Textebene aller Innenseiten als ein durchgehender Text."""
    ohne = ohne_seiten or set()
    innen = {k: v for k, v in seiten.items() if k not in ohne}
    grund = _grundschrift(innen)
    zeilen: list[_Zeile] = []
    kleine: list[_Zeile] = []
    for seite in sorted(innen):
        auf_seite = _zeilen(seite, innen[seite], grund)
        if _ist_werbeseite(auf_seite, grund):
            continue
        # Fussnoten stehen unten in einer Spalte, mitten in einem Absatz, der
        # in der naechsten Spalte weiterlaeuft. Im Lesetext gehoeren sie
        # hinter den Text ihrer Seite.
        kleine.extend(z for z in auf_seite if _klasse(z, grund) == "klein")
        zeilen.extend(z for z in auf_seite if _klasse(z, grund) != "klein")
    # Fussnoten einer Seite hinter den Absatz, in dem ihr letzter Text steht:
    # sonst risse "vergan-" | Fussnote | "genen Stunden" den Satz auf.
    absaetze = _absaetze(zeilen, grund)
    letzte_auf_seite: dict[int, int] = {}
    for n, (_erste, teil) in enumerate(absaetze):
        for z in teil:
            letzte_auf_seite[z.seite] = n
    nach: dict[int, list[tuple[_Zeile, list[_Zeile]]]] = {}
    for erste, teil in _absaetze(kleine, grund):
        ziel = letzte_auf_seite.get(erste.seite, len(absaetze) - 1)
        nach.setdefault(ziel, []).append((erste, teil))
    folge: list[tuple[_Zeile, list[_Zeile]]] = []
    for n, a in enumerate(absaetze):
        folge.append(a)
        folge.extend(nach.get(n, []))
    rechts: dict[tuple[int, int], float] = {}
    for z in zeilen:
        k = (z.seite, z.spalte)
        rechts[k] = max(rechts.get(k, 0.0), z.x1)
    blocks: list[SourceBlock] = []
    for erste, teil in folge:
        text = _absatz_text(teil, rechts)
        if not text:
            continue
        klasse = _klasse(erste, grund)
        if klasse == "klein" and not FUSSNOTE.match(text):
            # Bildunterschriften und Kleingedrucktes ohne Bild: weg.
            continue
        kind = "heading" if klasse == "kapitel" else "paragraph"
        blocks.append(
            SourceBlock(
                page_index=erste.seite,
                text=text,
                x0=min(z.x0 for z in teil),
                y0=erste.y0,
                x1=max(z.x1 for z in teil),
                y1=max(z.y1 for z in teil),
                size=erste.groesse,
                kind=kind,
                origin="pdf",
            )
        )
    if not blocks:
        return []
    erster = next((b.text for b in blocks if b.kind == "heading"), None)
    return [AssembledArticle(title=(titel or erster or "Ganzes Heft").strip(), blocks=blocks)]
