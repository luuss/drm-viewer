"""Heftangaben auslesen, damit sie niemand abtippen muss.

Zwei Quellen, jede fuer das, was sie sicher weiss:

* Der **Einzelpreis** steht im Impressum des Innenteils ("Einzelheft: 9,80").
  Das ist Text, also verlaesslich.
* Der **Erscheinungszeitraum** steht nur auf der Titelseite, in der Kopfzeile
  ueber dem Titel ("Nr. 170 · Maerz-April 2026 · 9,80"). Die Titelseite ist ein
  Bild, dafuer braucht es Texterkennung.

Die Heftnummer wird hier nicht gelesen: sie steht im Ordnernamen, und dort
steht sie eindeutig. Im Fliesstext eines Hefts stehen dagegen viele Zahlen, die
wie eine Heftnummer aussehen.

Was sich nicht sicher lesen laesst, bleibt leer. Geraten wird nichts — ein
falscher Preis ist schlimmer als gar keiner.
"""

from __future__ import annotations

import re

# Das Eurozeichen steht in den Heften in einer Symbolschrift und kommt aus der
# Textebene je nach Datei als "t", "€" oder "E" heraus.
EURO = r"[€teE€]"

PREIS = re.compile(
    r"Einzel(?:heft|preis|verkaufspreis)\s*:?\s*"
    rf"(?:{EURO}\s*)?(\d{{1,3}})[,.](\d{{2}})\s*(?:{EURO})?",
    re.IGNORECASE,
)

MONATE = {
    "januar": 1, "februar": 2, "märz": 3, "maerz": 3, "marz": 3, "april": 4,
    "mai": 5, "juni": 6, "juli": 7, "august": 8, "september": 9,
    "oktober": 10, "november": 11, "dezember": 12,
}
MONAT = "|".join(MONATE)
ZEITRAUM = re.compile(
    rf"\b({MONAT})\s*(?:[–\-/]|bis)\s*({MONAT})\s*(20\d\d)\b", re.IGNORECASE
)
EINZELMONAT = re.compile(rf"\b({MONAT})\s*(20\d\d)\b", re.IGNORECASE)
# Wieviele Seiten vom Ende her nach dem Impressum abgesucht werden. Es steht
# je nach Reihe auf der letzten oder der vorletzten Doppelseite.
SEITEN_VOM_ENDE = 6


def _seitentexte(pdf_bytes: bytes) -> list[str]:
    import io

    import pdfplumber

    texte: list[str] = []
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        anzahl = len(pdf.pages)
        indizes = sorted(
            set(range(max(0, anzahl - SEITEN_VOM_ENDE), anzahl)) | {0, 1}
        )
        for i in indizes:
            if i >= anzahl:
                continue
            try:
                texte.append(pdf.pages[i].extract_text() or "")
            except Exception:
                texte.append("")
    return texte


def parse_issue_meta(texte: list[str]) -> dict:
    """Den Einzelpreis aus den Seitentexten des Innenteils lesen."""
    meta: dict = {}
    for text in texte:
        if "priceAmountCents" in meta:
            break
        treffer = PREIS.search(text)
        if treffer:
            euro, cent = int(treffer.group(1)), int(treffer.group(2))
            # Ein Heft unter einem Euro oder ueber zweihundert ist kein Preis,
            # sondern ein Lesefehler.
            if 1 <= euro <= 200:
                meta["priceAmountCents"] = euro * 100 + cent

    return meta


def read_issue_meta(pdf_bytes: bytes) -> dict:
    """Wie `parse_issue_meta`, liest die Seiten aber selbst aus dem PDF."""
    try:
        return parse_issue_meta(_seitentexte(pdf_bytes))
    except Exception:
        return {}


def publication_date(meta: dict) -> int | None:
    """Erscheinungsdatum als Zeitstempel in Millisekunden.

    Genommen wird der erste Tag des ersten Monats — das Heft liegt ab dann vor.
    """
    if "monthFrom" not in meta or "year" not in meta:
        return None
    import datetime

    tag = datetime.datetime(meta["year"], meta["monthFrom"], 1, tzinfo=datetime.timezone.utc)
    return int(tag.timestamp() * 1000)


# Die Titelseite wird nicht gelesen.
#
# Sie kommt als Bild aus der Druckvorstufe, also ginge es nur ueber
# Texterkennung — und die verwechselt Ziffern: aus 13,80 wird 13,60. Der
# Einzelpreis steht ohnehin an einer verlaesslicheren Stelle: im Netzladen des
# Verlags, als Text ausgezeichnet. Von dort holt ihn `publicationCovers`.
