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
