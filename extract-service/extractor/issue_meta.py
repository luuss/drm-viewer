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


# --- Titelseite ------------------------------------------------------------

TESSERACT_SPRACHE = "deu"
# Die Kopfzeile steht im oberen Fuenftel der Titelseite. Mehr zu lesen bringt
# nur die Schlagzeilen mit, in denen ebenfalls Monatsnamen vorkommen koennen.
KOPF_ANTEIL = 0.22


def read_cover_meta(image_bytes: bytes) -> dict:
    """Erscheinungszeitraum und Preis aus der Kopfzeile der Titelseite lesen.

    Die Zeile ist bei allen Reihen gleich aufgebaut: Heftnummer, Zeitraum,
    Preis. Sie ist klein gesetzt, deshalb wird der Streifen vergroessert und im
    Kontrast angehoben, bevor die Texterkennung darueber geht.

    Ohne Tesseract im System bleibt das Ergebnis leer; der Import laeuft dann
    ohne diese Angaben weiter.
    """
    try:
        import io
        import subprocess
        import tempfile

        from PIL import Image, ImageOps
    except Exception:
        return {}

    try:
        bild = Image.open(io.BytesIO(image_bytes)).convert("L")
        breite, hoehe = bild.size
        kopf = bild.crop((0, 0, breite, max(1, int(hoehe * KOPF_ANTEIL))))
        kopf = ImageOps.autocontrast(
            kopf.resize((kopf.width * 4, kopf.height * 4), Image.LANCZOS)
        )
        with tempfile.NamedTemporaryFile(suffix=".png") as fh:
            kopf.save(fh.name)
            fertig = subprocess.run(
                ["tesseract", fh.name, "stdout", "-l", TESSERACT_SPRACHE, "--psm", "11"],
                capture_output=True,
                text=True,
                timeout=60,
            )
        return parse_cover_text(fertig.stdout)
    except FileNotFoundError:
        return {}
    except Exception:
        return {}


def parse_cover_text(text: str) -> dict:
    """Zeitraum und Preis aus dem erkannten Text der Kopfzeile."""
    meta: dict = {}
    treffer = ZEITRAUM.search(text)
    if treffer:
        meta["monthFrom"] = MONATE[treffer.group(1).lower()]
        meta["monthTo"] = MONATE[treffer.group(2).lower()]
        meta["year"] = int(treffer.group(3))
    else:
        treffer = EINZELMONAT.search(text)
        if treffer:
            meta["monthFrom"] = meta["monthTo"] = MONATE[treffer.group(1).lower()]
            meta["year"] = int(treffer.group(2))
    # Der Preis der Titelseite ist nur ein Rueckfall: die Texterkennung
    # verwechselt dort gern Ziffern, das Impressum ist echter Text.
    preis = re.search(r"\b(\d{1,2})[,.](\d{2})\b", text)
    if preis:
        euro, cent = int(preis.group(1)), int(preis.group(2))
        if 1 <= euro <= 200:
            meta["coverPriceAmountCents"] = euro * 100 + cent
    return meta
