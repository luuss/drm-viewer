"""Abo-Aufrufe erkennen: wirbt eine Seite um Abonnenten, und fuer welche Reihe?

Auf U2 und U3 steht meist ein Aufruf, das Heft zu abonnieren — oft fuer eine
andere Reihe desselben Verlags (in ZUERST! wirbt die DMZ). Ein solcher Aufruf
wird kein Artikel: im Seitenmodus fuehrt ein Tipp auf die Seite gleich zum
Abo-Formular der beworbenen Reihe im Laden. Hier steht nur die Erkennung;
was daraus wird, entscheidet der Worker.
"""

from __future__ import annotations

import re

ABO_WORTE = re.compile(
    r"\b(?:abo|abos|abonnement|abonnements|abonnieren|abonnent(?:en|in|innen)?|"
    r"jahresabo|geschenkabo(?:nnement)?|probeabo|schnupperabo|abo-?bestell\w*)\b",
    re.I,
)

# Reihen des Verlags, wie sie im Text genannt werden; jede Reihe bekommt ihre
# eigenen Treffer. "ZEITGESCHICHTE" kommt aus der Kapitaelchenschrift oft als
# "Z EitgEschichtE" heraus, deshalb ohne Z — und "DMZ Zeitgeschichte" zaehlt
# nicht als DMZ. "Deutschen Militaerzeitschrift (DMZ)" ist eine Nennung.
REIHEN: list[tuple[str, re.Pattern[str]]] = [
    ("dmz-zeitgeschichte", re.compile(r"eitgeschichte|\bdmz-?zg\b", re.I)),
    ("schwertertraeger", re.compile(r"bibliothek der tapfersten|schwertertr(?:ä|ae)ger", re.I)),
    ("zuerst", re.compile(r"\bzuerst\b", re.I)),
    (
        "dmz",
        re.compile(
            r"deutschen?\s+militärzeitschrift(?:\s*\(dmz\))?"
            r"|\bdmz\b(?![\s\-]*z?[\s\-]*eitgeschichte|-?zg\b)",
            re.I,
        ),
    ),
]

# Die Verlagsanschrift nennt die DMZ, ohne dass fuer sie geworben wird.
VERLAGSZEILE = re.compile(r"verlag deutsche militärzeitschrift|\bvdmz\b", re.I)
IMPRESSUM = re.compile(r"\bimpressum\b", re.I)


def abo_aufruf(
    text: str,
    titel: str = "",
    eigene_reihe: str | None = None,
    *,
    min_treffer: int = 3,
    max_zeichen: int | None = None,
) -> str | None:
    """Die Reihe, fuer die der Text um ein Abonnement wirbt — sonst None.

    Ein Aufruf nennt das Abo mehrfach (`min_treffer`); das Impressum nennt es
    auch, ist aber keiner. Fuer Innenseiten begrenzt `max_zeichen` auf
    Anzeigenlaenge, damit kein Artikel ueber das Abowesen zum Link wird.
    Welche Reihe: die im Titel dreifach, im Text einfach gezaehlten
    Nennungen. Die eigene Reihe des Hefts gewinnt jeden Gleichstand — ein
    Aufruf fuer das eigene Heft erwaehnt gern das Kombi-Abo mit der Schwester —,
    und sie gilt auch bei schwachem Befund.
    """
    if max_zeichen is not None and len(text) > max_zeichen:
        return None
    if IMPRESSUM.search(titel) or IMPRESSUM.search(text):
        return None
    if len(ABO_WORTE.findall(text)) < min_treffer:
        return None
    bereinigt = VERLAGSZEILE.sub(" ", text)
    punkte = {
        slug: 3 * len(rx.findall(titel)) + len(rx.findall(bereinigt))
        for slug, rx in REIHEN
    }
    beste = max(punkte, key=lambda s: punkte[s])
    if eigene_reihe and punkte.get(eigene_reihe, 0) >= punkte[beste]:
        return eigene_reihe
    if punkte[beste] >= 2:
        return beste
    if eigene_reihe:
        return eigene_reihe
    return beste if punkte[beste] > 0 else None
