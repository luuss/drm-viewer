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


# --- Platzierte Bilder aus dem Satz ----------------------------------------


def _jpeg(breite: int, hoehe: int, farbe=(200, 120, 60)) -> bytes:
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (breite, hoehe), farbe).save(buf, format="JPEG", quality=80)
    return buf.getvalue()


class _Job:
    """Gerade so viel Job, wie `_artwork_image` braucht."""

    job_id = "j1"
    ARTWORK_TOLERANZ = worker.Job.ARTWORK_TOLERANZ
    _artwork_image = worker.Job._artwork_image
    _artwork_blob = worker.Job._artwork_blob

    def __init__(self, artwork: dict, blobs: dict) -> None:
        self._artwork = artwork
        self._blobs = blobs

    def _fetch(self, src):
        return self._blobs.get(src["assetId"])


def test_platziertes_bild_ersetzt_den_seitenausschnitt():
    """Deckt der Rahmen das ganze Bild, ist das Original die bessere Vorlage."""
    from extractor.model import SourceImage

    seite = _jpeg(1000, 1400)
    bild = SourceImage(page_index=0, x0=0.1, y0=0.1, x1=0.5, y1=0.5, link="foto.tif")
    job = _Job(
        {"foto.tif": {"assetId": "a1"}},
        # Rahmen 400x560 Punkte, Bild 800x1120 — dasselbe Verhaeltnis.
        {"a1": _jpeg(800, 1120)},
    )

    ergebnis = job._artwork_image(bild, seite)

    assert ergebnis is not None
    assert worker.render.image_size(ergebnis) == (800, 1120)


def test_beschnittenes_bild_bleibt_beim_seitenausschnitt():
    """Hat der Satz beschnitten, stuende im Artikel sonst mehr als gedruckt."""
    from extractor.model import SourceImage

    seite = _jpeg(1000, 1400)
    # Rahmen 400x140 (breit), Bild 800x1120 (hoch): der Satz zeigt einen Streifen.
    bild = SourceImage(page_index=0, x0=0.1, y0=0.1, x1=0.5, y1=0.2, link="foto.tif")
    job = _Job({"foto.tif": {"assetId": "a1"}}, {"a1": _jpeg(800, 1120)})

    assert job._artwork_image(bild, seite) is None


def test_ohne_passende_datei_bleibt_es_beim_seitenausschnitt():
    from extractor.model import SourceImage

    seite = _jpeg(1000, 1400)
    ohne = SourceImage(page_index=0, x0=0.1, y0=0.1, x1=0.5, y1=0.5)
    fremd = SourceImage(
        page_index=0, x0=0.1, y0=0.1, x1=0.5, y1=0.5, link="unbekannt.tif"
    )
    job = _Job({"foto.tif": {"assetId": "a1"}}, {"a1": _jpeg(800, 1120)})

    assert job._artwork_image(ohne, seite) is None
    assert job._artwork_image(fremd, seite) is None


def test_titelseite_als_bild_wird_zur_druckseite():
    jpeg, breite, hoehe = worker.render.render_image_page(_jpeg(1241, 1754), width_px=800)

    assert (breite, hoehe) == (800, 1131)
    assert worker.render.image_size(jpeg) == (800, 1131)


def test_kleine_titelseite_wird_nicht_vergroessert():
    _jpeg_bytes, breite, hoehe = worker.render.render_image_page(
        _jpeg(600, 800), width_px=2400
    )

    assert (breite, hoehe) == (600, 800)


def test_satzdatei_als_beiwerk_gehoert_zum_innenteil():
    """Die Oberflaeche legt die IDML als Beiwerk ab, gemeint ist der Innenteil.

    Vorher suchte der Worker eine PDF-Quelle mit derselben Rolle. Die gab es
    nie, also blieb es still beim Weg ueber das PDF — und die Bildrahmen aus
    dem Satz lagen ungenutzt herum.
    """
    from extractor.model import SourceImage

    aufrufe = {}

    class _Job:
        job_id = "j1"
        _images_from_idml = worker.Job._images_from_idml
        _halves_by_asset: dict = {}

    job = _Job()
    sources = [
        {"kind": "pdf", "role": "inner", "assetId": "innen"},
        {"kind": "pdf", "role": "cover", "assetId": "umschlag"},
    ]
    idml_source = {"kind": "idml", "role": "supplemental", "assetId": "satz"}
    blobs = {"innen": b"%PDF", "umschlag": b"%PDF", "satz": b"idml"}
    alt = [SourceImage(page_index=0, x0=0, y0=0, x1=1, y1=1)]

    def falsche_frames(_bytes):
        aufrufe["frames"] = True
        return [object()]

    def trims(_blob, _map, _halves):
        return {0: (0.0, 0.0, 1.0, 1.0)}

    def zu_bildern(_frames, _map, _trims):
        return [SourceImage(page_index=0, x0=0.1, y0=0.1, x1=0.4, y1=0.4, link="a.tif")]

    import extractor.idml_extract as idml_extract

    alt_frames = worker.extract_idml_image_frames
    alt_trims = worker.read_trim_boxes
    alt_bilder = worker.frames_to_images
    try:
        worker.extract_idml_image_frames = falsche_frames
        worker.read_trim_boxes = trims
        worker.frames_to_images = zu_bildern
        ergebnis = job._images_from_idml(
            b"idml", idml_source, sources, blobs, {"innen": [(0, 0)]}, alt
        )
    finally:
        worker.extract_idml_image_frames = alt_frames
        worker.read_trim_boxes = alt_trims
        worker.frames_to_images = alt_bilder

    assert aufrufe.get("frames") is True
    assert [i.link for i in ergebnis] == ["a.tif"]
