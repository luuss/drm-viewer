"""Kopf der Artikel aus dem Satz: Zeile, Einleitung, Unterzeile, Autor, Titel.

Die Lagen und Formatnamen stammen aus den echten Heften (ZUERST!, DMZ,
DMZ-Zeitgeschichte); jede Regel wird an dem Heft geprueft, fuer das sie
gedacht ist, und an einem anderen Heft derselben Reihe, in dem sie nicht
greifen darf.
"""
from __future__ import annotations

import os
import sys
from types import SimpleNamespace as NS

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import worker  # noqa: E402
from extractor.idml_articles import artikel_aus_satz, rolle_fuer  # noqa: E402
from extractor.model import AssembledArticle, SourceBlock, TocHint  # noqa: E402

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
    karte = NS(page_index=page, x0=0.357, y0=0.0, x1=0.952, y1=0.263)
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
    foto = NS(page_index=7, x0=0.0, y0=0.0, x1=1.0, y1=0.5)
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
