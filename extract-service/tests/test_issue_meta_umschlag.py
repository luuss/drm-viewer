"""Erscheinungsmonat aus der Textebene der Titelseite."""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from extractor.issue_meta import erscheinung_aus_umschlag, publication_date  # noqa: E402


def umschlag(*zeilen, rolle="front_cover"):
    return json.dumps(
        {
            "version": 1,
            "cover": True,
            "pages": [
                {
                    "sourcePageIndex": 0,
                    "role": rolle,
                    "items": [[t, 0.1, y, 0.5, y + 0.01, 10] for t, y in zeilen],
                }
            ],
        }
    ).encode()


def test_gesperrte_kopfzeile_von_zuerst():
    # So steht es in ZUERST! 4/2025: Kopfzeile gesperrt gesetzt.
    meta = erscheinung_aus_umschlag(
        umschlag(("16. J a h r g a n g", 0.0156), ("A p r i l 2 0 2 5", 0.0156))
    )
    assert meta == {"monthFrom": 4, "monthTo": 4, "year": 2025}
    assert publication_date(meta) == 1743465600000  # 2025-04-01 UTC


def test_doppelmonat():
    meta = erscheinung_aus_umschlag(umschlag(("A u g u s t / S e p t e m b e r 2 0 2 5", 0.02)))
    assert meta == {"monthFrom": 8, "monthTo": 9, "year": 2025}


def test_anreisser_weiter_unten_zaehlen_nicht():
    # Oben die Kopfzeile, unten ein Anreisser mit einem anderen Datum.
    meta = erscheinung_aus_umschlag(
        umschlag(("Seit Januar 2020 im Amt", 0.8), ("M ä r z 2 0 2 6", 0.02))
    )
    assert meta["monthFrom"] == 3 and meta["year"] == 2026


def test_ohne_titelseite_oder_ohne_datum_bleibt_leer():
    assert erscheinung_aus_umschlag(umschlag(("April 2025", 0.02), rolle="inside_front")) == {}
    assert erscheinung_aus_umschlag(umschlag(("Kampfzone Indopazifik", 0.3))) == {}
    assert erscheinung_aus_umschlag(b"kein json") == {}
    # Die Textebene des Innenteils (ohne "cover") ist keine Titelseite.
    innen = json.dumps({"version": 1, "pages": [{"role": "front_cover", "items": [["April 2025", 0, 0, 1, 1, 9]]}]})
    assert erscheinung_aus_umschlag(innen.encode()) == {}
