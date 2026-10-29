"""Bilder-Nachtrag im Worker (drm-viewer-jmm): nur Bilder und Unterschriften neu."""
from __future__ import annotations

import worker
from extractor.model import AssembledArticle, SourceBlock, SourceImage
from tests.test_worker import _BildJob, _foto, _jpeg


class _NachtragJob(_BildJob):
    """Job mit Bestand: Artikel A traegt Story s1, Artikel B die Stories s2+s3."""

    _bilder_nachtrag = worker.Job._bilder_nachtrag

    def __init__(self, vorlagen):
        super().__init__(vorlagen)
        self.job_id = "job-000123456"
        self.gesendet: list[dict] = []

    def post(self, path, body):
        if path == "/service/jobs/articles":
            return [
                {"articleId": "A", "stories": ["s1"]},
                {"articleId": "B", "stories": ["s2", "s3"]},
            ]
        if path == "/service/jobs/bilder":
            self.gesendet.append(body)
            return {"artikel": len(body["articles"]), "geaendert": 1}
        return f"asset-{len(self.abgelegt)}"


def _satzartikel(story_ids, bilder, titel="T"):
    bloecke = [
        SourceBlock(
            page_index=33, text=f"Absatz {s} mit genug Text.", x0=0.1, y0=0.1 + i / 10,
            x1=0.5, y1=0.15 + i / 10, origin="idml", story_id=s,
        )
        for i, s in enumerate(story_ids)
    ]
    return AssembledArticle(title=titel, blocks=bloecke, images=bilder)


def test_bilder_nachtrag_nur_fuer_artikel_mit_gegenstueck():
    foto = SourceImage(
        page_index=33, x0=0.05, y0=0.75, x1=0.64, y1=1.0, link="IMG_2460.tif",
        caption="Bürgermeister Laurens Nothdurft mit Schülern.",
    )
    foto.after_block_order = 1
    anders = SourceImage(page_index=33, x0=0.6, y0=0.1, x1=0.9, y1=0.3, link="karte.tif")
    job = _NachtragJob({"IMG_2460.tif": _foto(800, 560, 0), "karte.tif": _foto(800, 560, 99)})
    artikel = [
        _satzartikel(["s1"], [foto], "Den Blick nach vorn richten"),
        # s2 allein: im Bestand gehoert s2 zu B mit s3, also kein Gegenstueck.
        _satzartikel(["s2"], [anders], "Anders geschnitten"),
    ]

    status, meldung = job._bilder_nachtrag(artikel, {33: _jpeg(1000, 1400)}, probe=False)

    assert status == "done"
    assert len(job.gesendet) == 1
    eingabe = job.gesendet[0]["articles"]
    assert [e["articleId"] for e in eingabe] == ["A"]
    bild = eingabe[0]["images"][0]
    assert bild["caption"] == "Bürgermeister Laurens Nothdurft mit Schülern."
    assert bild["anchorText"].startswith("Absatz s1")
    assert eingabe[0]["imageRegions"][0]["pageIndex"] == 33
    # Eigener Dateiname: die alten Bildzeilen bleiben bis zum Ruecksetzen gueltig.
    assert job.abgelegt and all(k.endswith("-n123456.jpg") for k in job.abgelegt)
    assert "ohne Gegenstueck im Bestand: 1" in meldung


def test_bilder_nachtrag_probelauf_legt_nichts_ab():
    foto = SourceImage(page_index=33, x0=0.05, y0=0.75, x1=0.64, y1=1.0, caption="Unterschrift.")
    job = _NachtragJob({})
    _status, meldung = job._bilder_nachtrag(
        [_satzartikel(["s1"], [foto])], {33: _jpeg(100, 140)}, probe=True
    )
    assert job.gesendet == [] and job.abgelegt == []
    assert "unterschriftenNachher 1" in meldung
