"""Gedrucktes Inhaltsverzeichnis im Buch-Modus (extractor/buch_verzeichnis.py).

Vorlagen unter fixtures/buch_verzeichnis/, aus den Textebenen der Anlage
digital.weltkrieg-online.de (05.11.2026):

* magazin.json: die Verzeichnisseite von acht WELTKRIEG-Magazin-Heften, je
  mit einem Sonderfall der Textebene, dazu bei Heft 83 die Seite davor.
* erzaehlhefte.json: die sechs Seiten aus Erzaehlheften (von 392), die am
  ehesten wie ein Verzeichnis aussehen: das Stueck "Inhalt" auf der Seite
  oder zwei Zeilen mit Seitenzahl am Rand.

Ueber alle 436 Hefte der Anlage gelaufen: greift in allen 44 Magazin-Heften
und in keinem anderen.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from extractor.buch_verzeichnis import buch_verzeichnis, verzeichnisseiten  # noqa: E402
from extractor.toc_layout import text_layer_for_pages  # noqa: E402

VORLAGEN = Path(__file__).parent / "fixtures" / "buch_verzeichnis"
MAGAZIN = json.loads((VORLAGEN / "magazin.json").read_text())
ERZAEHLHEFTE = json.loads((VORLAGEN / "erzaehlhefte.json").read_text())


def _lesen(heft: dict):
    pages = heft["pages"]
    content = sorted(
        (p["sourcePageIndex"], p["index"]) for p in pages if p["role"] == "content"
    )
    seiten = text_layer_for_pages(json.dumps(heft["textebene"]).encode(), content)
    return buch_verzeichnis(seiten, pages), pages


def _eintraege(nummer: str) -> list[tuple[str, str, str | None]]:
    """(gedruckte Zielseite, Titel, Rubrik) je Eintrag."""
    hints, pages = _lesen(MAGAZIN[nummer])
    label = {p["index"]: p["printedLabel"] for p in pages}
    return [(label[h.page_index], h.label, h.section) for h in hints]


def test_magazin_83_alle_eintraege_mit_rubrik():
    assert _eintraege("83") == [
        ("3", "Major Wolfgang Wahl", "Soldatenbiographie"),
        ("19", "Tscherkassy 1944", None),
        ("21", "Mitsubishi G3M", None),
        ("23", "Spähpanzer VEC", None),
        ("25", "Halten, nichts als halten!", "Erlebnisbericht"),
        ("40", "Die Träger des Großkreuzes des Greifenordens", None),
        ("48", "Den letzten holen die Hunde!", "Erlebnisbericht"),
        ("51", "Die deutsche U-Boot-Taktik", None),
        ("53", "Die 30. Infanterie-Division", None),
        ("55", "Tankgewehr M1918", None),
        ("57", "Narvik erobert und wieder verloren", "Erlebnisbericht"),
        ("74", "Der Morion", None),
        ("75", "FV433 Abbot", None),
        ("77", "Das ist noch nicht das Ende!", "Deutsche Panzer stoppen den Vormarsch auf Tilly 1944"),
        ("89", "Generalfeldmarschall Prinz Leopold von Bayern", None),
        ("92", "USS „Enterprise“ CVN-65", None),
    ]


def test_magazin_83_die_seite_davor_ist_kein_verzeichnis():
    hints, _pages = _lesen(MAGAZIN["83"])
    assert len(verzeichnisseiten(hints)) == 1


def test_zielseite_ueber_die_gedruckte_seitenzahl():
    """Heft 1 hat keine U2: die gedruckte 3 ist dort Leserseite 1, nicht 2."""
    hints, pages = _lesen(MAGAZIN["1"])
    erste = hints[0]
    assert erste.label == "Generalmajor Karl-Lothar Schulz"
    assert erste.printed == 3
    assert erste.page_index == 1
    assert {p["index"]: p["printedLabel"] for p in pages}[erste.page_index] == "3"


def test_ligatur_als_eigenes_stueck():
    titel = [t for _s, t, _r in _eintraege("1")]
    assert "Das Enfield-Gewehr" in titel
    # Die Zeile mit Leiste und Zahl im selben Stueck.
    assert "Der Erste Kreuzzug (1096–1099)" in titel


def test_eintrag_ohne_punktleiste():
    eintraege = _eintraege("93")
    assert ("27", "Marsch durch den Apennin", "Erlebnisbericht") in eintraege
    assert ("3", "Oberleutnant Hans-Arnold Stahlschmidt", "Soldatenbiographie") in eintraege
    # Rubrik und Dachzeile in einer Zeile ueber dem Titel.
    assert ("82", "Die Panzerkompanie (z.b.V.) 66", "Erlebnisbericht: Die Landung auf Malta 1942") in eintraege
    assert len(eintraege) == 16


def test_nur_der_kolumnentitel_nennt_die_seite():
    """Heft 96: die grosse Ueberschrift fehlt in der Textebene."""
    eintraege = _eintraege("96")
    assert len(eintraege) == 17
    # Zahl im Titel: die Textebene verliert die Bindestriche, sie werden
    # nicht dazuerfunden.
    assert ("72", "Soltam 120 mm Mörser", None) in eintraege


def test_zahl_im_titel_ist_keine_seitenzahl():
    titel = {s: t for s, t, _r in _eintraege("98")}
    assert titel["22"] == "Lockheed Martin F 35"
    # Zwei Punkte hinter einem langen Titel sind noch eine Leiste.
    assert titel["78"] == "Das Ende der 24. Panzer-Division in Stalingrad im Februar 1943"


def test_titel_ueber_zwei_zeilen():
    titel = {s: t for s, t, _r in _eintraege("99")}
    assert titel["78"] == (
        "Hölle Stalingrad: Die 29. Infanterie-Division unter General Leyser "
        "in den letzten Kämpfen in Stalingrad-Mitte 1943"
    )
    titel = {s: t for s, t, _r in _eintraege("101")}
    # Getrennt am Zeilenende, der Strich als eigenes Stueck.
    assert titel["84"] == (
        "Ein amerikanischer „Brandenburger“: Nach Inhaftierung 1944 in Bukarest "
        "nimmt ein Landser sein Schicksal in die Hand"
    )


def test_heft_mit_satzdatei():
    """Heft 106 kam mit IDML; die Textebene des Druck-PDF reicht trotzdem."""
    eintraege = _eintraege("106")
    assert eintraege[0] == ("3", "Generalmajor Heinz Trettner", "Soldatenbiographie")
    assert ("34", "Wer befehligt das „Mammut“?", "Erlebnisbericht") in eintraege
    assert len(eintraege) == 16


def test_flaeche_liegt_auf_der_zeile():
    hints, _pages = _lesen(MAGAZIN["83"])
    tscherkassy = next(h for h in hints if h.label == "Tscherkassy 1944")
    assert 0.28 < tscherkassy.y0 < 0.29 < 0.30 < tscherkassy.y1 < 0.315
    assert tscherkassy.x0 < 0.11 and tscherkassy.x1 > 0.89


@pytest.mark.parametrize("heft", ERZAEHLHEFTE, ids=lambda h: h["heft"])
def test_greift_nicht_in_erzaehlheften(heft):
    hints, _pages = _lesen(heft)
    assert hints == []


def test_ohne_gedruckte_seitenzahlen_kein_verzeichnis():
    heft = dict(MAGAZIN["83"])
    heft["pages"] = [{**p, "printedLabel": None} for p in heft["pages"]]
    hints, _pages = _lesen(heft)
    assert hints == []


# --- Worker ----------------------------------------------------------------

import worker  # noqa: E402
from extractor.model import AssembledArticle, SourceBlock  # noqa: E402


class _Convex:
    def __init__(self):
        self.gesendet: list[tuple[str, dict]] = []

    def post(self, path, body):
        self.gesendet.append((path, body))
        return {"regions": len(body.get("regions", [])), "skipped": 0, "entries": 0}


class _VerzeichnisJob:
    _buch_verzeichnis_erneuern = worker.Job._buch_verzeichnis_erneuern

    def __init__(self):
        self.job_id = "job-1"
        self.issue_id = "issue-1"
        self.convex = _Convex()
        self._text_pages = {}

    def beat(self, progress, message):
        pass


def _auftrag(heft: dict):
    job = _VerzeichnisJob()
    quellen = [{"kind": "text", "role": "inner", "assetId": "t"}]
    blobs = {"t": json.dumps(heft["textebene"]).encode()}
    status = job._buch_verzeichnis_erneuern(heft["pages"], blobs, quellen)
    return job, status


def test_verzeichnis_auftrag_ersetzt_das_verzeichnis():
    job, (zustand, meldung) = _auftrag(MAGAZIN["83"])
    assert zustand == "done"
    assert meldung.startswith("Inhaltsverzeichnis: 16 Eintraege")
    [(pfad, body)] = job.convex.gesendet
    assert pfad == "/service/jobs/toc-regions"
    assert body["ersetzen"] is True
    assert len(body["entries"]) == len(body["regions"]) == 16
    assert body["entries"][4] == {
        "label": "Halten, nichts als halten!",
        "pageIndex": body["regions"][4]["targetPageIndex"],
        "section": "Erlebnisbericht",
    }


def test_verzeichnis_auftrag_ohne_gedrucktes_verzeichnis_aendert_nichts():
    job, (zustand, meldung) = _auftrag(ERZAEHLHEFTE[0])
    assert zustand == "done"
    assert "unveraendert" in meldung
    assert job.convex.gesendet == []


def test_build_toc_entries_im_buch_modus(monkeypatch):
    monkeypatch.setattr(worker, "IMPORT_MODUS", "buch")
    hints, _pages = _lesen(MAGAZIN["83"])
    text = AssembledArticle(
        title="Das ist noch nicht das Ende!",
        blocks=[
            SourceBlock(page_index=s, text="…", x0=0.1, y0=0.1, x1=0.9, y1=0.2)
            for s in range(2, 95)
        ],
    )
    payload = [{"order": 1, "regions": []}]
    entries = worker.Job._build_toc_entries(None, hints, [text], payload)
    assert len(entries) == 16
    assert {e["articleOrder"] for e in entries} == {1}
    # Der Eintrag heisst wie der eine Text, bleibt aber auf seiner gedruckten
    # Seite (kein "Druckfehler", der auf den Textanfang zeigt).
    ende = next(e for e in entries if e["label"] == "Das ist noch nicht das Ende!")
    assert ende["pageIndex"] == next(h.page_index for h in hints if h.printed == 77)
    # Je Zeile eine Klickflaeche auf der Verzeichnisseite.
    assert len(payload[0]["regions"]) == 16
    assert {r["pageIndex"] for r in payload[0]["regions"]} == verzeichnisseiten(hints)
