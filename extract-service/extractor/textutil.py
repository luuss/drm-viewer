"""Textaufbereitung fuer Satzdateien aus dem Druck."""

import re
import unicodedata

SOFT_HYPHEN = "­"


def clean_text(raw: str) -> str:
    """Trennstriche, Sonderleerzeichen und Umbrueche aus dem Satz entfernen."""
    # Bedingter Trennstrich heisst immer: das Wort geht direkt weiter.
    t = re.sub(SOFT_HYPHEN + r"[ \t]*\n?[ \t]*", "", raw)
    t = t.replace(" ", "\n").replace(" ", "\n\n")
    # Geschuetzte und schmale Leerzeichen auf normale abbilden.
    t = re.sub(r"[     ]", " ", t)
    # Am Zeilenende getrennte Woerter zusammenziehen: "Sozialversiche-\nrung".
    t = re.sub(r"(\w)-\s*\n\s*(\w)", r"\1\2", t)
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r" *\n *", "\n", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    # Zeilenumbrueche aus dem Satz sind keine Absaetze: im Fliesstext stoeren sie.
    t = re.sub(r"(?<!\n)\n(?!\n)", " ", t)
    t = re.sub(r"[ \t]{2,}", " ", t)
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
