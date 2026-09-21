from __future__ import annotations

import worker


def test_idle_polling_steigt_exponentiell_bis_zum_limit(monkeypatch):
    monkeypatch.setattr(worker, "POLL_SECONDS", 5.0)
    monkeypatch.setattr(worker, "IDLE_POLL_MAX_SECONDS", 60.0)

    assert [worker.idle_poll_delay(i) for i in range(7)] == [
        5.0,
        10.0,
        20.0,
        40.0,
        60.0,
        60.0,
        60.0,
    ]


def test_idle_polling_respektiert_ein_kleineres_maximum(monkeypatch):
    monkeypatch.setattr(worker, "POLL_SECONDS", 30.0)
    monkeypatch.setattr(worker, "IDLE_POLL_MAX_SECONDS", 10.0)

    assert worker.idle_poll_delay(0) == 30.0
    assert worker.idle_poll_delay(12) == 30.0


def test_inhaltseintrag_ohne_verzeichnisseite_bekommt_keine_klickflaeche():
    """Ein Editorial aus der Heftkonvention steht im Inhalt, aber nirgends klickbar."""
    from extractor.model import AssembledArticle, SourceBlock, TocHint

    block = SourceBlock(
        page_index=2, text="Verehrter Leser", x0=0.1, y0=0.1, x1=0.9, y1=0.2
    )
    articles = [AssembledArticle(title="Editorial", blocks=[block])]
    payload = [{"order": 1, "regions": []}]
    hints = [
        TocHint("Editorial", 2, None, 0.0, 0.0, 0.0, 0.0),
        TocHint("Ohne Artikel", 9, 3, 0.1, 0.1, 0.4, 0.2),
    ]

    entries = worker.Job._build_toc_entries(None, hints, articles, payload)

    assert entries == [
        {"order": 1, "label": "Editorial", "pageIndex": 2, "level": 1, "articleOrder": 1},
        {"order": 2, "label": "Ohne Artikel", "pageIndex": 9, "level": 1},
    ]
    assert payload[0]["regions"] == []
