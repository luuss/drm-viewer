"""Kopf der Artikel aus dem Satz: Zeile, Einleitung, Unterzeile, Autor, Titel.

Die Lagen und Formatnamen stammen aus den echten Heften (ZUERST!, DMZ,
DMZ-Zeitgeschichte); jede Regel wird an dem Heft geprueft, fuer das sie
gedacht ist, und an einem anderen Heft derselben Reihe, in dem sie nicht
greifen darf.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import worker  # noqa: E402
from extractor.idml_articles import artikel_aus_satz, rolle_fuer  # noqa: E402
from extractor.model import SourceImage, AssembledArticle, SourceBlock, TocHint  # noqa: E402

SPALTE_1 = (0.048, 0.061, 0.333, 0.943)
SPALTE_2 = (0.357, 0.061, 0.643, 0.943)
SPALTE_3 = (0.667, 0.061, 0.952, 0.943)
ZEILE = (0.048, 0.074, 0.643, 0.182)
EINLEITUNG = (0.048, 0.189, 0.643, 0.236)


def rb(text: str, story: str, style: str, page: int, box: tuple) -> SourceBlock:
    return SourceBlock(
        page_index=page,
        text=text,
        x0=box[0],
        y0=box[1],
        x1=box[2],
        y1=box[1] + 0.02,
        kind="heading" if "berschrift" in style else "paragraph",
        origin="idml",
        story_id=story,
        frame_id=f"{story}-{page}-{box[0]}",
        style_name=style,
        frame_box=box,
    )


def zuerst_artikel(n: str, page: int, titel: list[str], einleitung: list[str], text: str):
    """Eine ZUERST!-Seite: Hauptueberschrift, Einleitungstext, drei Spalten."""
    return (
        [rb(z, f"k{n}", "Hauptüberschrift", page, ZEILE) for z in titel]
        + [rb(z, f"e{n}", "Einleitungstext", page, EINLEITUNG) for z in einleitung]
        + [
            rb(text + " Satz." * 120, f"t{n}", "Mengentext mit Initiale", page, SPALTE_1),
            rb("Weiter im Text." * 20, f"t{n}", "Mengentext", page, SPALTE_2),
            rb("Joachim Wiessner", f"t{n}", "Autorenname", page, SPALTE_3),
        ]
    )


# --- Aufgabe A: Einleitungen rutschen nicht weiter ------------------------


def _wahlkarte(page: int) -> tuple[list[SourceBlock], list]:
    """ZUERST! 4/2025, S. 45: Wahlkarte Belgiens mit Beschriftung im Format
    "Einleitungstext", darunter der Rest eines Artikels der Vorseite."""
    karte = SourceImage(page_index=page, x0=0.357, y0=0.0, x1=0.952, y1=0.263)
    etiketten = [
        ("Stimmenstärkste Parteien", (0.73, 0.019, 0.941, 0.046)),
        ("N-VA", (0.839, 0.056, 0.964, 0.066)),
        ("Flandern", (0.5, 0.059, 0.609, 0.071)),
        ("Vlaams Belang", (0.839, 0.083, 0.964, 0.093)),
        ("Wallonien", (0.593, 0.16, 0.702, 0.172)),
        ("Brüssel", (0.372, 0.149, 0.481, 0.161)),
    ]
    blocks = [rb(t, f"karte{i}", "Einleitungstext", page, box) for i, (t, box) in enumerate(etiketten)]
    return blocks, [karte]


def test_kartenbeschriftung_nimmt_dem_naechsten_artikel_nicht_die_einleitung():
    karte, bilder = _wahlkarte(44)
    blocks = (
        zuerst_artikel("0", 43, ["Einheit und Zwiespalt"], ["Nach langen Verhandlungen"], "Daß Regierungsbildungen")
        + [rb("Der Markenkern der N-VA " + "x" * 300, "t0", "Mengentext", 44, SPALTE_1)]
        + karte
        + zuerst_artikel("1", 45, ["Feindbild Euro"], ["In Bulgarien wehrt sich die Opposition"], "In Bulgarien flammt")
        + zuerst_artikel("2", 46, ["Deutlich", "höhere Hürden"], ["Schwedens konservative Regierung"], "Schweden kommt")
        + zuerst_artikel("3", 47, ["„Marxisten-", "Schlangennest“"], ["Die Trump-Regierung stampft"], "Nach Donald Trumps")
    )
    artikel = artikel_aus_satz(blocks, bilder)
    kopf = [(a.title, a.pages[0], a.pages[-1], a.subtitle or a.teaser) for a in artikel]
    assert kopf == [
        ("Einheit und Zwiespalt", 43, 44, "Nach langen Verhandlungen"),
        ("Feindbild Euro", 45, 45, "In Bulgarien wehrt sich die Opposition"),
        ("Deutlich höhere Hürden", 46, 46, "Schwedens konservative Regierung"),
        ("„Marxisten-Schlangennest“", 47, 47, "Die Trump-Regierung stampft"),
    ]
    # Die Beschriftung der Karte steht in keinem Artikel.
    texte = {b.text for a in artikel for b in a.blocks}
    assert not texte & {"Flandern", "Wallonien", "N-VA", "Stimmenstärkste Parteien"}


def test_zeile_und_einleitung_auf_dem_aufmacherfoto_bleiben():
    """ZUERST! 3/2026, S. 8: Zeile und Einleitung stehen auf dem Foto.

    Zwei Rahmen und eine Bildunterschrift machen aus dem Foto keine Karte.
    """
    foto = SourceImage(page_index=7, x0=0.0, y0=0.0, x1=1.0, y1=0.5)
    blocks = [
        rb("Vergiftete", "k", "Hauptüberschrift", 7, (0.048, 0.33, 0.643, 0.438)),
        rb("Nachbarschaft", "k", "Hauptüberschrift", 7, (0.048, 0.33, 0.643, 0.438)),
        rb("Im komplexbeladenen Polen", "e", "Einleitungstext", 7, (0.048, 0.444, 0.643, 0.492)),
        rb("Grenze an der Oder.", "c", "Bildunterschrift weiß", 7, (0.667, 0.316, 0.952, 0.397)),
        rb("Polen " + "x" * 500, "t", "Mengentext mit Initiale", 7, (0.048, 0.337, 0.952, 0.943)),
    ]
    [a] = artikel_aus_satz(blocks, [foto])
    assert a.title == "Vergiftete Nachbarschaft"
    assert (a.subtitle or a.teaser) == "Im komplexbeladenen Polen"


def test_text_in_der_karte_ist_beschriftung():
    """ZUERST! 3/2026: Ortsnamen und Prozentwerte im Format "Text in der Karte"."""
    assert rolle_fuer("Text in der Karte") == "grafik"
    blocks = [
        rb("Ganz in Schwarz " + "x" * 500, "t", "Mengentext mit Initiale", 60, SPALTE_1),
        rb("Kastilien", "g1", "Text in der Karte", 60, (0.429, 0.859, 0.476, 0.869)),
        rb("32 %", "g2", "Text in der Karte", 60, (0.816, 0.83, 0.84, 0.84)),
    ]
    [a] = artikel_aus_satz(blocks)
    assert [b.text for b in a.blocks] == [blocks[0].text]
    # Ein Kasten derselben Seite bleibt ein Kasten.
    kasten = rb("Merke dies", "b1", "Kasten Text 2023", 60, (0.7, 0.7, 0.9, 0.8))
    [a] = artikel_aus_satz(blocks + [kasten])
    assert [b.kind for b in a.blocks] == ["paragraph", "box"]


# --- Aufgabe A/G: das Verzeichnis findet seinen Artikel beim Titel ------------


def _artikel(titel: str, seiten: list[int]) -> AssembledArticle:
    return AssembledArticle(
        title=titel,
        blocks=[SourceBlock(page_index=s, text=titel, x0=0.1, y0=0.1, x1=0.9, y1=0.2) for s in seiten],
    )


def test_verzeichnis_findet_den_artikel_beim_titel_auch_bei_verschobenen_seiten():
    """4/2025: die Artikel trugen Seitenbereiche, die eine Seite zu frueh begannen."""
    articles = [
        _artikel("Feindbild Euro", [44, 45]),
        _artikel("Deutlich höhere Hürden", [45, 46]),
        _artikel("„Marxisten-Schlangennest“", [46, 47, 48]),
    ]
    payload = [{"order": i + 1, "regions": []} for i in range(3)]
    hints = [
        TocHint("Feindbild Euro", 45, 3, 0.1, 0.1, 0.4, 0.2),
        TocHint("Deutlich höhere Hürden", 46, 3, 0.1, 0.2, 0.4, 0.3),
        TocHint("„Marxisten-Schlangennest“", 47, 3, 0.1, 0.3, 0.4, 0.4),
    ]
    entries = worker.Job._build_toc_entries(None, hints, articles, payload)
    assert [e.get("articleOrder") for e in entries] == [1, 2, 3]


def test_leserbriefe_impressum_fuehrt_zu_den_leserbriefen():
    """ZUERST!: "Leserbriefe/Impressum 81" — die Briefe beginnen auf S. 80."""
    articles = [_artikel("Buchbesprechungen", [77]), _artikel("Leserbriefe", [79, 80]), _artikel("Zuletzt", [81])]
    payload = [{"order": i + 1, "regions": []} for i in range(3)]
    hints = [
        TocHint("Leserbriefe/Impressum", 80, 3, 0.1, 0.1, 0.4, 0.2),
        TocHint("Zuletzt", 81, 3, 0.1, 0.2, 0.4, 0.3),
    ]
    entries = worker.Job._build_toc_entries(None, hints, articles, payload)
    assert [(e["label"], e.get("articleOrder")) for e in entries] == [
        # Die stehende Rubrik ohne gedruckten Eintrag kommt dazu.
        ("Buchbesprechungen", 1),
        ("Leserbriefe/Impressum", 2),
        ("Zuletzt", 3),
    ]


def test_rubrikeintrag_ohne_titel_fuehrt_zum_ersten_artikel_der_seite():
    """3/2026: "Innere Sicherheit 33" nennt keinen Titel; es gilt die Seite."""
    articles = [
        _artikel("Multikulti-Horror im Osten", [31]),
        _artikel("„Gewalt als Dienstleistung“ im Internet", [32]),
        _artikel("„Problematische Machokultur“ an hessischen Schulen", [32]),
    ]
    payload = [{"order": i + 1, "regions": []} for i in range(3)]
    hints = [TocHint("Innere Sicherheit", 32, 3, 0.1, 0.1, 0.4, 0.2)]
    entries = worker.Job._build_toc_entries(None, hints, articles, payload)
    assert entries[0]["articleOrder"] == 2


# --- Aufgabe C: Unterzeile und Vorspann -----------------------------------


def test_zuerst_einleitung_ist_die_unterzeile():
    """ZUERST! 3/2026, S. 23: der Einleitungstext unter der Zeile."""
    blocks = zuerst_artikel(
        "1",
        22,
        ["Wahlrechtsentzug", "statt Strafpsychiatrie"],
        ["Die Bundesregierung plant den Entzug der Wählbarkeit", "bei einer Verurteilung wegen Volksverhetzung"],
        "Nein, die Bundesrepublik",
    )
    [a] = artikel_aus_satz(blocks)
    assert a.subtitle == (
        "Die Bundesregierung plant den Entzug der Wählbarkeit bei einer Verurteilung wegen Volksverhetzung"
    )
    # Im Lesetext steht sie nicht noch einmal.
    lesetext = worker._ohne_kopfzeilen(a.blocks, a)
    assert [b.kind for b in lesetext][:1] == ["paragraph"]


def test_langer_vorspann_bleibt_im_text():
    """DMZ 170, S. 11: der Vorspann des Soldatenportraets hat 600 Zeichen."""
    vorspann = [
        "„Frido“ von Senger und Etterlin stammte aus einer adeligen Familie. Im Ersten Weltkrieg "
        "bewährte er sich als Artillerist. Zur Kavallerie versetzt, kämpfte er 1940 in Holland und "
        "in Frankreich. Als Verbindungsoffizier war er bei der Waffenstillstandskommission in Turin,",
        "danach führte er eine Panzerdivision. Für seine Erfolge wurde ihm 1944 das 439. Eichenlaub verliehen.",
        "Nach dem Krieg beteiligte er sich am Aufbau der Bundeswehr.",
    ]
    blocks = (
        [rb("Weltgewandter Offizier von Adel", "k", "HÜ Soldatenporträt 2023", 10, (0.05, 0.08, 0.95, 0.15))]
        + [rb(z, "u", "UÜ Soldatenporträt 2023", 10, (0.05, 0.16, 0.95, 0.25)) for z in vorspann]
        + [rb("Fridolin Rudolf " + "x" * 600, "t", "Mengentext Initiale 2023", 10, (0.05, 0.3, 0.33, 0.94))]
    )
    [a] = artikel_aus_satz(blocks)
    assert a.subtitle is None and a.teaser is None
    lesetext = worker._ohne_kopfzeilen(a.blocks, a)
    assert [b.kind for b in lesetext] == ["lead", "paragraph"]
    # Ein Absatz, die Zeilen verbunden.
    assert lesetext[0].text.startswith("„Frido“ von Senger")
    assert "Turin, danach führte er" in lesetext[0].text


def test_kurze_unterzeile_der_dmz_bleibt_unterzeile():
    """DMZ 170, S. 5: "Unterüberschrift 2023" — so wie bisher."""
    blocks = [
        rb("Schicksalsschlacht", "k", "Überschrift 2023", 4, (0.05, 0.08, 0.95, 0.15)),
        rb("Napoleon unterliegt bei Waterloo", "u", "Unterüberschrift 2023", 4, (0.05, 0.16, 0.95, 0.2)),
        rb("Die Schlacht " + "x" * 600, "t", "Mengentext Initiale 2023", 4, (0.05, 0.22, 0.33, 0.94)),
    ]
    [a] = artikel_aus_satz(blocks)
    assert a.subtitle == "Napoleon unterliegt bei Waterloo"
    assert a.teaser is None


# --- Aufgabe B: Autor ---------------------------------------------------------


def _titelgeschichte_mit_anzeige() -> list[SourceBlock]:
    """ZUERST! 3/2026, S. 15: Buchanzeige in der rechten Spalte der Titelgeschichte.

    Schlagzeile im Format "Autorenname Katalog", Beschreibung und Preis im
    Format "Mengentext Katalog", der Preis in einem eigenen Rahmen.
    """
    return [
        rb("Vergiftete", "k", "Hauptüberschrift", 7, ZEILE),
        rb("Nachbarschaft", "k", "Hauptüberschrift", 7, ZEILE),
        rb("Im Herbst 2022 " + "x" * 2000, "t", "Mengentext mit Initiale", 7, SPALTE_1),
        rb("Weiter auf Seite 15 " + "y" * 900, "t", "Mengentext", 14, (0.048, 0.061, 0.643, 0.943)),
        rb("Hartmut Lieger, Christian Schöps, Ludwig Kranzler", "t", "Autorenname", 15, SPALTE_3),
        rb("Was die Deutschen", "anz-kopf", "Autorenname Katalog", 14, (0.667, 0.068, 0.952, 0.113)),
        rb("nicht wissen sollen", "anz-kopf", "Autorenname Katalog", 14, (0.667, 0.068, 0.952, 0.113)),
        rb(
            "Nachdem ein Gericht die Vernichtung der Restauflage angeordnet hatte, " + "z" * 560,
            "anz",
            "Mengentext Katalog",
            14,
            (0.675, 0.375, 0.94, 0.646),
        ),
        rb("€ 32,80", "anz-preis", "Mengentext Katalog", 14, (0.876, 0.646, 0.949, 0.672)),
    ]


def test_schlagzeile_einer_anzeige_ist_nie_autor():
    artikel = artikel_aus_satz(_titelgeschichte_mit_anzeige())
    titel = artikel[0]
    assert titel.title == "Vergiftete Nachbarschaft"
    assert titel.author == "Hartmut Lieger, Christian Schöps, Ludwig Kranzler"
    # Schlagzeile und Preis gehoeren zur Anzeige, nicht in die Titelgeschichte.
    assert "€ 32,80" not in [b.text for b in titel.blocks]
    anzeige = artikel[1]
    assert anzeige.title == "Was die Deutschen nicht wissen sollen"
    assert anzeige.blocks[-1].text == "€ 32,80"


def test_autorzeile_im_eigenen_rahmen_bleibt_autor():
    """Ein Autor in eigenem Rahmen ohne Anzeigenformat zaehlt weiter."""
    blocks = [
        rb("Begeisterter Flieger", "k", "hauptüberschrift schwerter", 2, ZEILE),
        rb("Robert Greim wurde " + "x" * 600, "t", "mengentext schwerter", 2, SPALTE_1),
        rb("Peter Stockert", "a", "autorenname schwerter", 2, (0.667, 0.9, 0.952, 0.92)),
    ]
    [a] = artikel_aus_satz(blocks)
    assert a.author == "Peter Stockert"


def test_kurzer_anzeigenteil_geht_an_die_anzeige_in_deren_rahmen_er_steht():
    """DMZ-Zeitgeschichte 80, S. 43: "5 Bände im Schuber" steht im Rahmen der
    Divisionsgeschichte (Preis und Artikelnummer im Text, Format des
    Mengentexts), nicht bei der Katalog-Anzeige darunter."""
    blocks = [
        rb(
            "Im März 1933 als Stabswache Berlin gegründet " + "x" * 600 + " Art. 101543 € 148,–",
            "gross",
            "Mengentext DMZ-Zeit 2018",
            42,
            (0.04, 0.107, 0.96, 0.649),
        ),
        rb("5 Bände", "schuber", "Mengentext Katalog", 42, (0.036, 0.517, 0.251, 0.577)),
        rb("im Schuber", "schuber", "Mengentext Katalog", 42, (0.036, 0.517, 0.251, 0.577)),
        rb(
            "Der älteste Truppenteil der Waffen-SS " + "y" * 500 + " Art. 101077 € 39,80",
            "klein",
            "Mengentext Katalog",
            42,
            (0.052, 0.698, 0.471, 0.92),
        ),
    ]
    artikel = artikel_aus_satz(blocks)
    texte = [[b.text for b in a.blocks] for a in artikel]
    assert "5 Bände" in texte[0] and "5 Bände" not in texte[1]


# --- Aufgabe D: Titel ------------------------------------------------------------


def test_editorial_anrede_ist_erster_absatz_nicht_titel():
    """ZUERST!: "Sehr geehrte Leser," steht im Format "Kleine Überschrift rot"."""
    from extractor.rubriken import titel_bereinigen

    blocks = [
        rb("Sehr geehrte Leser,", "t", "Kleine Überschrift rot", 2, (0.135, 0.242, 0.487, 0.88)),
        rb("nicht selten sind die größten Feinde " + "x" * 600, "t", "Mengentext", 2, (0.135, 0.242, 0.487, 0.88)),
    ]
    [a] = artikel_aus_satz(blocks)
    assert a.title_from_body
    assert [(b.kind, b.text) for b in a.blocks][0] == ("paragraph", "Sehr geehrte Leser,")
    assert titel_bereinigen(a.title, aus_text=True, seitenrubrik="EDITORIAL") == "Editorial"


def test_dmz_anrede_in_zwei_absaetzen_wird_einer():
    """DMZ 170, S. 3: "Verehrter" / "Leser," ohne Format vor dem Text."""
    blocks = [
        rb("Verehrter", "t", "$ID/NormalParagraphStyle", 2, (0.449, 0.103, 0.952, 0.944)),
        rb("Leser,", "t", "$ID/NormalParagraphStyle", 2, (0.449, 0.103, 0.952, 0.944)),
        rb("kaum ist das Jahr 2025 zur Neige gegangen " + "x" * 600, "t", "Mengentext 2023", 2, (0.449, 0.103, 0.952, 0.944)),
    ]
    [a] = artikel_aus_satz(blocks)
    assert [b.text for b in a.blocks][0] == "Verehrter Leser,"
    assert a.title_from_body


def test_meldungszeile_ueber_zwei_absaetze_ist_ein_titel():
    """ZUERST! 5/2025, S. 20: "Abgang einer" / "Überzeugungstäterin: Faesers fatale Bilanz"."""
    box = (0.667, 0.061, 0.952, 0.936)
    blocks = [
        rb("Abgang einer", "t", "Kleine Überschrift rot", 19, box),
        rb("Überzeugungstäterin: Faesers fatale Bilanz", "t", "Kleine Überschrift rot", 19, box),
        rb("Vor dem Hintergrund " + "x" * 600, "t", "Mengentext mit Initiale", 19, box),
    ]
    [a] = artikel_aus_satz(blocks)
    assert a.title == "Abgang einer Überzeugungstäterin: Faesers fatale Bilanz"
    assert [b.kind for b in a.blocks] == ["heading", "heading", "paragraph"]


def test_kalenderblatt_zeile_in_drei_absaetzen():
    """DMZ 170, S. 64: "Erich Raeder" / "vergrößert" / "die Kriegsmarine"."""
    box = (0.652, 0.302, 0.952, 0.935)
    blocks = [rb(z, "t", "Überschrift Kalender 2023", 63, box) for z in ("Erich Raeder", "vergrößert", "die Kriegsmarine")]
    blocks.append(rb("Erich Raeder hatte seit 1928 " + "x" * 800, "t", "Text Nachrichten 2023", 63, box))
    [a] = artikel_aus_satz(blocks)
    assert a.title == "Erich Raeder vergrößert die Kriegsmarine"


def test_zwei_meldungen_in_einem_textrahmen_werden_zwei_artikel():
    """ZUERST! 3/2026, S. 25: Wadephul und der Bundeswehr-General in einer Story."""
    box = (0.667, 0.061, 0.952, 0.936)
    blocks = [
        rb("Wadephul warnt vor", "t", "Kleine Überschrift rot", 24, box),
        rb("Debatte über NATO-Zerfall", "t", "Kleine Überschrift rot", 24, box),
        rb("Außenminister Johann Wadephul " + "x" * 600, "t", "Mengentext mit Initiale", 24, box),
        rb("Bundeswehr-General", "t", "Kleine Überschrift rot", 24, box),
        rb("verlangt Atombombe", "t", "Kleine Überschrift rot", 24, box),
        rb("Der Bundeswehr-Brigadegeneral Frank Pieper " + "y" * 300, "t", "Mengentext mit Initiale", 24, box),
    ]
    artikel = artikel_aus_satz(blocks)
    assert [a.title for a in artikel] == [
        "Wadephul warnt vor Debatte über NATO-Zerfall",
        "Bundeswehr-General verlangt Atombombe",
    ]
    # Eine Meldung allein bleibt ein Artikel.
    [a] = artikel_aus_satz(blocks[:3])
    assert a.title == "Wadephul warnt vor Debatte über NATO-Zerfall"


def test_buchbesprechung_heisst_nach_dem_besprochenen_buch():
    from extractor.idml_articles import buchtitel_aus_angabe

    assert buchtitel_aus_angabe(
        "Christiane Hoffmann. Alles, was wir nicht erinnern: Zu Fuß auf dem Fluchtweg meines Vaters. "
        "279 S., geb., € 22,–. München: C.H. Beck, 2022."
    ) == "Christiane Hoffmann: Alles, was wir nicht erinnern"
    assert buchtitel_aus_angabe(
        "Cora Stephan (Hrsg.). Deutsche Legenden: Wer schreibt unsere Geschichte? 248 S., Pb., € 22,–."
    ) == "Cora Stephan (Hrsg.): Deutsche Legenden"
    assert buchtitel_aus_angabe(
        "Erich Thöle/Martin Glade. Veteranen der Waffen-SS berichten. Bd. 12. 120 S., geb., € 18,80."
    ) == "Erich Thöle/Martin Glade: Veteranen der Waffen-SS berichten. Bd. 12"
    assert buchtitel_aus_angabe(
        "Claus-M. Wolfschlag. Das andere Buch: Ein Untertitel. 96 S., geb., € 10,–."
    ) == "Claus-M. Wolfschlag: Das andere Buch"
    # Keine Buchangabe: eine Anzeige mit Umfang und Preis, ein Satz mit "S.".
    assert buchtitel_aus_angabe("384 S., viele Abb., geb. im Großformat. € 32,80") is None
    assert buchtitel_aus_angabe("Mit Grüßen aus der Redaktion. Siehe S. 12, oben.") is None

    box = (0.667, 0.236, 0.952, 0.943)
    blocks = [
        rb("Endzeit in Schlesien. Im Dorf Rosenthal bricht 1945 ein Treck auf. " + "x" * 1500, "t", "Mengentext mit Initiale", 77, box),
        rb("Christiane Hoffmann. Alles, was wir nicht erinnern: Zu Fuß auf dem Fluchtweg meines Vaters. "
           "279 S., geb., € 22,–. München: C.H. Beck, 2022.", "t", "Mengentext mit Initiale", 77, box),
    ]
    [a] = artikel_aus_satz(blocks)
    assert a.title == "Christiane Hoffmann: Alles, was wir nicht erinnern"
    assert not a.title_from_body


def test_kolumne_heisst_nach_dem_titel_in_ihrem_textrahmen():
    """ZUERST! 3/2026, S. 38: "Unseriöse Medien" in einem Rahmen ohne Format
    mitten im Textrahmen der Kolumne. Ein Rahmen ausserhalb (Seitenfuss)
    zaehlt nicht."""
    text = (0.066, 0.29, 0.932, 0.929)
    blocks = [
        rb("Durch das, mit dem wir unseren Kopf füttern " + "x" * 3000, "t", "Mengentext mit Initiale", 37, text),
        rb("Dr. Claus-M. Wolfschlag ist freier Publizist.", "t", "Mengentext", 37, text),
        rb("Unseriöse Medien", "titel", "$ID/[No paragraph style]", 37, (0.375, 0.431, 0.625, 0.461)),
        rb("3/2026 · Deutsches Nachrichtenmagazin", "fuss", "$ID/NormalParagraphStyle", 37, (0.512, 0.956, 0.871, 0.976)),
    ]
    [a] = artikel_aus_satz(blocks)
    assert a.title == "Unseriöse Medien"
    assert not a.title_from_body
    # Ohne den Titelrahmen bleibt der Titel aus dem Text (dann gilt die Rubrik).
    [a] = artikel_aus_satz([b for b in blocks if b.story_id != "titel"])
    assert a.title_from_body


def test_verfasser_der_kolumne_aus_dem_verzeichnis():
    from extractor.rubriken import verfasser_aus_eintrag

    assert verfasser_aus_eintrag("Claus-M. Wolfschlag: Die Kolumne") == "Claus-M. Wolfschlag"
    assert verfasser_aus_eintrag("Pius Leitner: Die Kolumne") == "Pius Leitner"
    # Kein Verfasser: Doppelpunkt im Titel, Rubrik ohne Namen.
    assert verfasser_aus_eintrag("Abschiebungen in NRW: Chronik des Scheiterns") is None
    assert verfasser_aus_eintrag("Die Kolumne") is None
    assert verfasser_aus_eintrag("Kalenderblatt – Personen") is None


def _anzeige(zeilen: list[tuple[str, str]], text: str = "Beschreibung des Buches. " * 8 + "288 S., geb., € 22,–") -> list[SourceBlock]:
    box = (0.232, 0.808, 0.399, 0.92)
    return [rb(t, "a", stil, 78, box) for t, stil in zeilen] + [rb(text, "a", zeilen[-1][1].replace("Autor", "Text").replace("titel", "text"), 78, box)]


def test_buchanzeige_trennt_verfasser_titel_und_untertitel():
    # ZUERST! 1/2025, S. 79: Verfasser und Titel beide im Autorformat.
    [a] = artikel_aus_satz(_anzeige([("Gustav Sichelschmidt", "Bücherseite Autor 2018"), ("Wie im alten Rom", "Bücherseite Autor 2018")]))
    assert (a.title, a.author) == ("Wie im alten Rom", "Gustav Sichelschmidt")
    lesetext = worker._ohne_kopfzeilen(a.blocks, a)
    assert [b.text for b in lesetext][0].startswith("Beschreibung")
    # ZUERST! 10/2025: zwei Verfasser, die Zeile endet mit "/".
    [a] = artikel_aus_satz(_anzeige([
        ("Alexander Marguier/", "werbeseite autor"),
        ("Ben Krischke (Hg.)", "werbeseite autor"),
        ("Die Wokeness-Illusion", "werbeseite titel"),
    ]))
    assert (a.title, a.author) == ("Die Wokeness-Illusion", "Alexander Marguier/Ben Krischke (Hg.)")


def test_buchanzeige_der_dmz_bleibt_wie_sie_war():
    """DMZ 170, S. 59: Verfasser im Autorformat, Titel im Titelformat."""
    [a] = artikel_aus_satz(_anzeige([("Danny Bauer", "Bücherseite Autor 2023"), ("Heinrich Kling", "Bücherseite Titel 2023")]))
    assert (a.title, a.author, a.subtitle) == ("Heinrich Kling", "Danny Bauer", None)
