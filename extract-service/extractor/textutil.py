"""Textaufbereitung fuer Satzdateien aus dem Druck."""

import re
import unicodedata

SOFT_HYPHEN = "­"

# Abgesetzte Akzente, wie sie eine Satzschrift ohne fertiges Zeichen setzt
# ("Ca˘lin", "Don˜a"), und der verbindende Akzent, der mit seinem Buchstaben
# das richtige Zeichen ergibt. Akut und Gravis fehlen mit Absicht: "´" steht
# im Fliesstext meist fuer den Apostroph ("geht´s"), und "ś" gibt es.
_AKZENTE = {
    "˘": "\u0306", "˜": "\u0303", "¨": "\u0308", "ˇ": "\u030c", "˚": "\u030a",
    "¸": "\u0327", "˛": "\u0328", "˝": "\u030b", "ˆ": "\u0302",
}


# Passen beide Nachbarn zum Akzent, gewinnt der Buchstabe, der in der
# Sprache dazu ueblich ist: "Kog˘alniceanu" (Rumaenisch ă), aber "Dog˘ru"
# (Tuerkisch ğ); "Don˜a" ist "Doña", nicht "Donã"; der Hatschek sitzt auf
# Konsonanten ("Cˇeské", "Sinkeviˇcius"), ebenso die Cedille ("Nicus¸or").
_VORZUG = {
    "˘": "aAgGuUoOeEiI",
    "˜": "nNaAoOuUiIeE",
    "ˇ": "cCsSzZrRnNdDtTlLeE",
    "¸": "sStTcCgGkKlLnNrR",
}


def _akzente_setzen(text: str) -> str:
    """"Ca˘lin" und "C˘alin" werden "Călin" — nur, wo es das Zeichen gibt.

    Je nach Schrift steht der Akzent hinter oder vor seinem Buchstaben; er
    gehoert zu dem Nachbarn, mit dem er ein fertiges Zeichen ergibt.
    """
    out: list[str] = []
    i = 0
    while i < len(text):
        zeichen = text[i]
        if (
            zeichen in _AKZENTE
            and out
            and out[-1].isalpha()
            and i + 1 < len(text)
            and text[i + 1].isalpha()
        ):
            akzent = _AKZENTE[zeichen]
            mit_davor = unicodedata.normalize("NFC", out[-1] + akzent)
            mit_danach = unicodedata.normalize("NFC", text[i + 1] + akzent)
            davor_geht, danach_geht = len(mit_davor) == 1, len(mit_danach) == 1
            if davor_geht and danach_geht:
                vorzug = _VORZUG.get(zeichen, "")
                rang = lambda b: vorzug.index(b) if b in vorzug else len(vorzug)  # noqa: E731
                danach_geht = rang(text[i + 1]) < rang(out[-1])
                davor_geht = not danach_geht
            if davor_geht:
                out[-1] = mit_davor
                i += 1
                continue
            if danach_geht:
                out.append(mit_danach)
                i += 2
                continue
        out.append(zeichen)
        i += 1
    return "".join(out)


def clean_text(raw: str) -> str:
    """Trennstriche, Sonderleerzeichen und Umbrueche aus dem Satz entfernen."""
    # Ein bedingter Trennstrich zwischen einem Buchstaben und einem
    # Grossbuchstaben ist in Wahrheit der Bindestrich des Wortes: InDesign setzt
    # ihn in "Nordrhein-Westfalen" oder "Mercosur-Abkommen" so, damit dort
    # umbrochen werden darf. Wird er wie eine Silbentrennung entfernt, steht im
    # Lesetext "NordrheinWestfalen". Vor einem Wort ("den <SHY>Direktor") oder
    # hinter einem Bindestrich ("Trump-<SHY>Regierung") verbietet er dagegen nur
    # die Trennung und faellt weg; als Strich stand dort "den -Direktor".
    t = re.sub(
        r"(?<=[^\W\d_])" + SOFT_HYPHEN + r"[ \t]*\n?[ \t]*(?=[A-ZÄÖÜ])", "-", raw
    )
    t = re.sub(SOFT_HYPHEN + r"[ \t]*\n?[ \t]*", "", t)
    # Zeichen aus Symbolschriften (Schlusszeichen, Zierrat) liegen im privaten
    # Bereich von Unicode und erscheinen im Lesetext als leeres Kaestchen.
    t = re.sub(r"[\ue000-\uf8ff]", "", t)
    t = _akzente_setzen(t)
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


# Nach einem Strich am Zeilenende, wenn das Wort davor nur halb steht:
# "Ein-" / "und Ausfuhr".
_BINDEWOERTER = {"und", "oder", "bis", "sowie", "als", "wie", "noch", "bzw.", "u.", "&"}


def zeilen_verbinden(zeilen) -> str:
    """Die Zeilen eines umbrochenen Titels (oder Kastens) zu einer verbinden.

    Steht im Satz jede Zeile als eigener Absatz, endet eine davon oft mit dem
    Trennstrich: "Marxisten-" / "Schlangennest" ist "Marxisten-Schlangennest",
    "Bahn-" / "mitarbeiter" ist "Bahnmitarbeiter". Mit Leerzeichen verbunden
    stand im Leser "Marxisten- Schlangennest".
    """
    out = ""
    for zeile in zeilen:
        zeile = " ".join((zeile or "").split())
        if not zeile:
            continue
        if not out:
            out = zeile
        elif re.search(r"[^\W\d_]-$", out) and zeile.split()[0].lower() not in _BINDEWOERTER:
            out = out[:-1] + zeile if zeile[0].islower() else out + zeile
        else:
            out += " " + zeile
    return out


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
