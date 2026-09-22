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


def test_ausschnitt_aus_dem_satz_schneidet_das_original():
    """Nennt der Satz den Ausschnitt, wird das Original danach geschnitten.

    Der Seitenausschnitt schleppte hier Nachbartext mit; aus der Datei kommt
    genau das, was gedruckt ist.
    """
    from extractor.model import SourceImage

    seite = _jpeg(1000, 1400)
    # Rahmen 400x140 (breit), Bild 800x1120 (hoch) — ohne Ausschnitt bliebe es
    # beim Seitenausschnitt. Der Satz zeigt den mittleren Streifen.
    bild = SourceImage(
        page_index=0,
        x0=0.1,
        y0=0.1,
        x1=0.5,
        y1=0.2,
        link="foto.tif",
        crop=(0.0, 0.4, 1.0, 0.525),
    )
    job = _Job({"foto.tif": {"assetId": "a1"}}, {"a1": _jpeg(800, 1120)})

    ergebnis = job._artwork_image(bild, seite)

    assert ergebnis is not None
    breite, hoehe = worker.render.image_size(ergebnis)
    assert breite == 800
    assert 130 <= hoehe <= 150


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
    nie, also blieb es still beim Weg ueber das PDF — und der ganze Satz lag
    ungenutzt herum.
    """
    sources = [
        {"kind": "pdf", "role": "cover", "assetId": "umschlag"},
        {"kind": "pdf", "role": "inner", "assetId": "innen"},
    ]
    blobs = {"innen": b"%PDF", "umschlag": b"%PDF"}

    partner = worker.Job._idml_partner(
        {"kind": "idml", "role": "supplemental"}, sources, blobs
    )
    assert partner is not None and partner["assetId"] == "innen"

    # Traegt die Satzdatei eine eigene Rolle, gilt die gleichnamige PDF.
    umschlag = worker.Job._idml_partner(
        {"kind": "idml", "role": "cover"}, sources, blobs
    )
    assert umschlag is not None and umschlag["assetId"] == "umschlag"


def test_ohne_geladene_pdf_gibt_es_keinen_partner():
    partner = worker.Job._idml_partner(
        {"kind": "idml", "role": "supplemental"},
        [{"kind": "pdf", "role": "inner", "assetId": "innen"}],
        {},
    )
    assert partner is None


def test_gedruckte_seitenzahl_ergibt_den_versatz():
    """Steht auf der ersten Innenseite eine 3 und liegt sie an Position 1,
    ist der Versatz 2. Die Funktion muss vor dem Einstiegspunkt stehen —
    sonst faellt der Worker erst im Betrieb darueber."""
    pages = [
        {"index": 0, "role": "front_cover", "printedLabel": "U1"},
        {"index": 1, "role": "content", "printedLabel": "3"},
        {"index": 2, "role": "content", "printedLabel": "4"},
    ]

    assert worker._printed_offset(pages) == 2
    assert worker._printed_offset([{"index": 0, "printedLabel": "U1"}]) == 0
    assert worker._printed_offset([]) == 0


def test_trefferflaeche_ist_der_rahmen_nicht_der_absatz():
    """Zwanzig Absaetze in einem Rahmen ergeben eine Flaeche, nicht zwanzig."""
    from extractor.model import SourceBlock

    def b(text: str, y: float) -> SourceBlock:
        return SourceBlock(
            page_index=4,
            text=text,
            x0=0.1,
            y0=y,
            x1=0.5,
            y1=y + 0.02,
            origin="idml",
            story_id="s",
            frame_id="f1",
            frame_box=(0.08, 0.12, 0.52, 0.88),
        )

    regionen = worker._text_regions([b("Erster", 0.2), b("Zweiter", 0.4)])

    assert regionen == [
        {"pageIndex": 4, "x0": 0.08, "y0": 0.12, "x1": 0.52, "y1": 0.88, "kind": "body"}
    ]


def test_ohne_satz_bleibt_der_block_die_trefferflaeche():
    from extractor.model import SourceBlock

    block = SourceBlock(
        page_index=2, text="Ueberschrift", x0=0.1, y0=0.1, x1=0.9, y1=0.2, kind="heading"
    )

    regionen = worker._text_regions([block])

    assert regionen[0]["kind"] == "title"
    assert regionen[0]["y1"] == 0.2


def test_zwei_rahmen_ergeben_zwei_flaechen():
    from extractor.model import SourceBlock

    def b(frame: str, kasten, seite: int) -> SourceBlock:
        return SourceBlock(
            page_index=seite,
            text="Text",
            x0=kasten[0],
            y0=kasten[1],
            x1=kasten[2],
            y1=kasten[3],
            origin="idml",
            story_id="s",
            frame_id=frame,
            frame_box=kasten,
        )

    regionen = worker._text_regions(
        [
            b("f1", (0.1, 0.1, 0.5, 0.9), 3),
            b("f2", (0.5, 0.1, 0.9, 0.9), 3),
            b("f1", (0.1, 0.1, 0.5, 0.9), 3),
        ]
    )

    assert len(regionen) == 2


def test_preis_von_der_titelseite_gilt_wenn_das_impressum_keinen_nennt(monkeypatch):
    """ZUERST! druckt im Impressum nur Abopreise; der Einzelpreis steht vorn."""
    gesendet: list[dict] = []

    class _Convex:
        def post(self, pfad, nachricht):
            gesendet.append({"pfad": pfad, **nachricht})
            return {}

    class _Job:
        issue_id = "i1"
        job_id = "j1"
        convex = _Convex()
        _store_meta = worker.Job._store_meta

    monkeypatch.setattr(
        worker, "read_cover_meta", lambda b: {"coverPriceAmountCents": 870}
    )
    monkeypatch.setattr(worker, "read_issue_meta", lambda b: {})
    monkeypatch.setattr(worker, "publication_date", lambda m: None)

    job = _Job()
    quellen = [
        {"kind": "pdf", "role": "inner", "assetId": "a1"},
        {"kind": "image", "role": "cover", "assetId": "a2"},
    ]
    job._store_meta(quellen, {"a1": b"x", "a2": b"y"})

    assert gesendet and gesendet[0]["priceAmountCents"] == 870


def test_impressum_schlaegt_die_titelseite(monkeypatch):
    gesendet: list[dict] = []

    class _Convex:
        def post(self, pfad, nachricht):
            gesendet.append(nachricht)
            return {}

    class _Job:
        issue_id = "i1"
        job_id = "j1"
        convex = _Convex()
        _store_meta = worker.Job._store_meta

    monkeypatch.setattr(
        worker, "read_cover_meta", lambda b: {"coverPriceAmountCents": 1360}
    )
    monkeypatch.setattr(worker, "read_issue_meta", lambda b: {"priceAmountCents": 1280})
    monkeypatch.setattr(worker, "publication_date", lambda m: None)

    _Job()._store_meta(
        [
            {"kind": "pdf", "role": "inner", "assetId": "a1"},
            {"kind": "image", "role": "cover", "assetId": "a2"},
        ],
        {"a1": b"x", "a2": b"y"},
    )

    assert gesendet[0]["priceAmountCents"] == 1280
