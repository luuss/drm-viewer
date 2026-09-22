"""Textaufbereitung fuer Satzdateien aus dem Druck."""

import re
import unicodedata

SOFT_HYPHEN = "­"


def clean_text(raw: str) -> str:
    """Trennstriche, Sonderleerzeichen und Umbrueche aus dem Satz entfernen."""
    # Ein bedingter Trennstrich vor einem Grossbuchstaben ist in Wahrheit der
    # Bindestrich des Wortes: InDesign setzt ihn in "Nordrhein-Westfalen" oder
    # "Mercosur-Abkommen" so, damit dort umbrochen werden darf. Wird er wie eine
    # Silbentrennung entfernt, steht im Lesetext "NordrheinWestfalen".
    t = re.sub(SOFT_HYPHEN + r"[ \t]*\n?[ \t]*(?=[A-ZÄÖÜ])", "-", raw)
    t = re.sub(SOFT_HYPHEN + r"[ \t]*\n?[ \t]*", "", t)
    t = t.replace(" ", "\n").replace(" ", "\n\n")
    # Geschuetzte und schmale Leerzeichen auf normale abbilden.
    t = re.sub(r"[     ]", " ", t)
    # Am Zeilenende getrennte Woerter zusammenziehen: "Sozialversiche-\nrung".
    # Folgt dem Strich ein Grossbuchstabe, ist er Teil des Wortes und bleibt:
    # "Zwangs-\nNacktuntersuchungen" ist ein Bindestrichwort, keine Silbentrennung.
    t = re.sub(r"(\w)-\s*\n\s*([a-zäöüß])", r"\1\2", t)
    t = re.sub(r"(\w)-\s*\n\s*([A-ZÄÖÜ])", r"\1-\2", t)
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r" *\n *", "\n", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    # Zeilenumbrueche aus dem Satz sind keine Absaetze: im Fliesstext stoeren sie.
    t = re.sub(r"(?<!\n)\n(?!\n)", " ", t)
    t = re.sub(r"[ \t]{2,}", " ", t)
    # InDesign setzt unsichtbare Marken in den Text: Byte-Reihenfolge-Marke
    # am Anfang eines Rahmens, Breitenull-Zeichen an Trennstellen. Im
    # Lesetext stehen sie als leere Kaestchen.
    t = t.replace("\ufeff", "").replace("\u200b", "").replace("\u200d", "")
    return t.strip()


def normalize_compare(s: str) -> str:
    s = unicodedata.normalize("NFKD", s.lower())
    return re.sub(r"[^a-z0-9]+", "", s)


def is_probably_heading(text: str) -> bool:
    t = text.strip()
    if not t or len(t) > 140:
        return False
    if t.endswith((".", ":", ";", ",")) and len(t) > 60:
        return False
    return True


def first_sentence(text: str, limit: int = 220) -> str:
    t = text.strip().replace("\n", " ")
    m = re.search(r"(.{40,%d}?[.!?])\s" % limit, t)
    if m:
        return m.group(1).strip()
    return t[:limit].strip()


DROPCAP_RE = re.compile(r"^(\d{1,3}\s+)?([A-ZÄÖÜ])\s+(?=[a-zäöüß])")


def glue_dropcap(text: str) -> str:
    """Initiale wieder ans Wort setzen.

    Im Satz steht die Initiale als eigenes Zeichen mit Abstand, beim Auslesen
    wird daraus "B ürgergeld". Eine vorangestellte Seitenzahl faellt dabei weg.
    """
    m = DROPCAP_RE.match(text)
    if not m:
        return text
    return m.group(2) + text[m.end():]


def is_meaningful(text: str) -> bool:
    """Taugt der Text als Titel oder Unterzeile?

    Gedrehter Satz kommt als Folge loser Einzelzeichen an. So etwas darf nicht
    als Unterzeile im Artikel landen, auch wenn es nur ein paar Zeichen sind.
    """
    tokens = text.split()
    if not tokens:
        return False
    # Ohne ein einziges richtiges Wort ist es Satzschrott: Preisleisten,
    # gesperrte Zierschrift, gedrehter Satz vom Umschlagruecken.
    if not any(re.search(r"[A-Za-zÄÖÜäöüß]{4}", t) for t in tokens):
        return False
    woerter = [t for t in tokens if len(t) >= 3]
    if len(woerter) >= 2:
        return True
    singles = sum(1 for t in tokens if len(t) <= 2)
    return singles / len(tokens) < 0.5 and len(text.strip()) >= 12
