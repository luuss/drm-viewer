"""Gemeinsame PDF-Seitengeometrie fuer Rendering und Extraktion."""

from __future__ import annotations

import math

Rect = tuple[float, float, float, float]


def half_of_box(box: Rect, half: str | None) -> Rect:
    """Linke oder rechte Haelfte eines Rechtecks (links, unten, rechts, oben).

    Umschlaege kommen aus der Druckvorstufe oft als Doppelseite: U4 und U1 auf
    dem ersten Bogen, U2 und U3 auf dem zweiten. Die Leserseite ist dann genau
    eine Haelfte des Netzformats. Ohne Angabe bleibt das Rechteck ganz.
    """
    if not half:
        return box
    left, bottom, right, top = box
    middle = (left + right) / 2
    if half == "left":
        return (left, bottom, middle, top)
    if half == "right":
        return (middle, bottom, right, top)
    raise ValueError(f"Unbekannte Seitenhaelfte: {half!r}")


def visible_page_box(page, half: str | None = None) -> Rect:
    """Netzformat einer PDF-Seite in PDF-Koordinaten (links, unten, rechts, oben).

    Druck-PDFs enthalten ausserhalb der TrimBox Anschnitt, Passermarken und bei
    Umschlaegen gelegentlich Inhalt des benachbarten Bogens. Die TrimBox ist
    deshalb die Leser-Seite. Fehlt sie, gelten CropBox und danach MediaBox.
    Mit `half` zaehlt nur die linke oder rechte Haelfte davon als Seite.
    """
    page_width = float(page.get_width())
    page_height = float(page.get_height())
    fallback: Rect = (0.0, 0.0, page_width, page_height)

    for getter_name in ("get_trimbox", "get_cropbox", "get_mediabox"):
        try:
            box = getattr(page, getter_name)()
        except Exception:
            continue
        if not box or len(box) != 4:
            continue
        left, bottom, right, top = (float(value) for value in box)
        if not all(math.isfinite(value) for value in (left, bottom, right, top)):
            continue
        # PDF-Boxen duerfen formal ueber die MediaBox hinausragen. Fuer das
        # Rasterbild ist nur die Schnittmenge mit der Seitenflaeche sinnvoll.
        left = min(max(left, 0.0), page_width)
        right = min(max(right, 0.0), page_width)
        bottom = min(max(bottom, 0.0), page_height)
        top = min(max(top, 0.0), page_height)
        if right - left >= 1.0 and top - bottom >= 1.0:
            return half_of_box((left, bottom, right, top), half)
    return half_of_box(fallback, half)


def rect_on_visible_page(rect: Rect, visible: Rect) -> Rect:
    """PDF-Rechteck auf die gerenderte TrimBox normieren, y von oben."""
    left, bottom, right, top = visible
    width = right - left
    height = top - bottom
    return (
        (rect[0] - left) / width,
        (top - rect[3]) / height,
        (rect[2] - left) / width,
        (top - rect[1]) / height,
    )
