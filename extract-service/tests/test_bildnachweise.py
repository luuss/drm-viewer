"""Bildnachweise am Bildrand (extractor/bildnachweise.py).

Die Lagen sind aus echten Seiten nachgebaut (Rahmen aus der IDML, auf die
Seite normiert, y von oben; Seitenzahl = Satzseite). Zu jeder Regel ein Fall,
in dem sie greift, und einer, in dem sie nicht greift.
"""
from extractor import bildnachweise as bn
from extractor.model import SourceBlock, SourceImage
from extractor.satzbilder import unterschriften_zuordnen


def bild(x0, y0, x1, y1, link="foto.tif", seite=0, gruppen=()):
    return SourceImage(page_index=seite, x0=x0, y0=y0, x1=x1, y1=y1, link=link, groups=gruppen)


def nachweis(text, box, seite=0, rahmen="n1", stil="Bildquelle", kind="other", gruppen=()):
    return SourceBlock(
        page_index=seite, text=text, x0=box[0], y0=box[1], x1=box[2], y1=box[3],
        kind=kind, origin="idml", story_id="s-" + rahmen, frame_id=rahmen,
        style_name=stil, frame_box=box, frame_groups=gruppen,
    )


# --- ZUERST! 8-9/2025 S. 5: gedreht rechts neben dem Foto ---------------------

def test_gedrehter_nachweis_rechts_neben_dem_foto():
    habeck = bild(0.667, 0.744, 0.952, 0.852, "BDK_Karlsruhe_Nov_2023_Robert_Habeck.tif")
    ttip = bild(0.244, 0.16, 0.433, 0.297, "Anti-TTIP.tif")
    blocks = [
        nachweis("Foto: Wikimedia/Kasa Fue/CC BY-SA 4.0", (0.954, 0.744, 0.968, 0.852), rahmen="a"),
        nachweis("Foto: Wikimedia/Bernd Schwabe/CC BY-SA 4.0", (0.435, 0.129, 0.45, 0.297), rahmen="b"),
    ]
    bn.zuordnen([habeck, ttip], blocks)
    assert habeck.credit == "Foto: Wikimedia/Kasa Fue/CC BY-SA 4.0"
    assert ttip.credit == "Foto: Wikimedia/Bernd Schwabe/CC BY-SA 4.0"


def test_nachweis_ohne_bild_daneben_bleibt_ohne_bild():
    """Diagramm aus InDesign (kein Bildrahmen): der Nachweis wandert nicht ans naechste Foto."""
    foto = bild(0.048, 0.06, 0.333, 0.33)
    blocks = [nachweis("Daten: Infratest Dimap", (0.954, 0.411, 0.969, 0.546))]
    ergebnis = bn.zuordnen([foto], blocks)
    assert foto.credit is None
    assert ergebnis[0][1] is None


# --- Spaltenzwischenraum: der Nachweis gehoert zum linken Foto ------------------

def test_nachweis_im_zwischenraum_gehoert_zum_linken_foto():
    """ZUERST! 7/2025 S. 7: 0,0016 neben Wadephul (links), 0,0008 neben Pistorius."""
    wadephul = bild(0.5978, 0.7003, 0.769, 0.8835, "Wadephul_by_OlafKosinsky.tif")
    pistorius = bild(0.781, 0.7003, 0.9522, 0.8956, "Pistorius_Pentagon.tif")
    blocks = [nachweis("Foto: Wikimedia/Olaf Kosinsky/CC BY-SA 3.0-de", (0.7706, 0.734, 0.7802, 0.936))]
    bn.zuordnen([wadephul, pistorius], blocks)
    assert wadephul.credit is not None
    assert pistorius.credit is None


def test_links_am_foto_wenn_rechts_keines_steht():
    """ZUERST! 8-9/2025 S. 5: links an der Kante, nichts links daneben."""
    indianer = bild(0.819, 0.198, 0.94, 0.322, "first-nation-908605.tif")
    blocks = [nachweis("Foto: Pixabay/NatashaG", (0.81, 0.208, 0.824, 0.322))]
    bn.zuordnen([indianer], blocks)
    assert indianer.credit == "Foto: Pixabay/NatashaG"


def test_naeheres_foto_gewinnt_bei_fast_gleichem_abstand():
    """ZUERST! 2/2025 S. 59: "U.S. Army" an den Ritchie Boys, nicht am Spiegel-Titel."""
    ritchie = bild(0.0476, 0.0606, 0.6429, 0.33, "Ritchie-Boys.tif")
    spiegel = bild(0.6611, 0.0486, 0.9724, 0.3378, "Spiegel-Cover.tif")
    blocks = [nachweis("Foto: U.S. Army", (0.6448, 0.1953, 0.659, 0.33))]
    bn.zuordnen([ritchie, spiegel], blocks)
    assert ritchie.credit == "Foto: U.S. Army"
    assert spiegel.credit is None


# --- gedreht heisst senkrechte Kante ------------------------------------------

def test_gedrehter_nachweis_zaehlt_nicht_an_der_oberkante_des_logos():
    """ZUERST! 4/2025 S. 42: der Rahmen reicht unten auf das Logo, gehoert zum Porträt."""
    portraet = bild(0.47, 0.37, 0.69, 0.57, "Bart_De_Wever_FOD_Kanselarij.tif")
    logo = bild(0.4645, 0.5724, 0.7095, 0.6355, "n-va logo.tif")
    blocks = [nachweis("Foto: Wikimedia/FOD Kanselarij van de Eerste Minister", (0.6921, 0.3737, 0.7063, 0.5758))]
    bn.zuordnen([portraet, logo], blocks)
    assert portraet.credit is not None
    assert logo.credit is None


def test_waagerechter_nachweis_unter_dem_foto():
    foto = bild(0.3, 0.1, 0.6, 0.3)
    blocks = [nachweis("Foto: Klinikum Nürnberg", (0.35, 0.302, 0.58, 0.315))]
    bn.zuordnen([foto], blocks)
    assert foto.credit == "Foto: Klinikum Nürnberg"


# --- Foto im Anschnitt: Nachweis im Seitenrand auf dem Foto -------------------

def test_nachweis_im_seitenrand_auf_dem_angeschnittenen_foto():
    """Greim S. 19: 0,048 vom Seitenrand, das Foto laeuft in den Anschnitt."""
    foto = bild(0.0, 0.5286, 1.0, 1.0, "21 - h_50146852 - farbig.tif")
    blocks = [nachweis("Foto: BPK Berlin/Siegfried Lauterwasser", (0.0476, 0.803, 0.0595, 0.9377), stil="bildquelle schwerter")]
    bn.zuordnen([foto], blocks)
    assert foto.credit == "Foto: BPK Berlin/Siegfried Lauterwasser"


def test_eingeklinktes_foto_schlaegt_den_hintergrund_unter_dem_nachweis():
    """Der Nachweis liegt auf dem grossen Foto, steht aber an der Kante des kleinen."""
    hintergrund = bild(0.0, 0.5, 1.0, 1.0, "hintergrund.tif")
    einklinker = bild(0.3, 0.6, 0.6, 0.8, "einklinker.tif")
    blocks = [nachweis("Foto: Archiv des Verfassers", (0.602, 0.62, 0.615, 0.8))]
    bn.zuordnen([hintergrund, einklinker], blocks)
    assert einklinker.credit == "Foto: Archiv des Verfassers"
    assert hintergrund.credit is None


# --- was kein Nachweis ist ----------------------------------------------------

def test_anzeige_und_platzhalter_sind_kein_nachweis():
    foto = bild(0.3, 0.1, 0.6, 0.3)
    blocks = [
        nachweis("Anzeige", (0.602, 0.1, 0.615, 0.3), rahmen="a"),
        nachweis("Foto: xxx", (0.35, 0.302, 0.58, 0.315), rahmen="b"),
    ]
    bn.zuordnen([foto], blocks)
    assert foto.credit is None


def test_anzeigentext_im_nachweisformat_ist_kein_nachweis():
    """ZUERST! 1/2025 S. 63: Kalenderanzeige im Format "Bildquelle"."""
    kalender = bild(0.6809, 0.1447, 0.87, 0.3327, "Germanische Welt 2025.tif")
    blocks = [nachweis("Germanische Welt 2025 Bilder aus der faszinierenden Welt unserer Urahnen", (0.6823, 0.3457, 0.9666, 0.3824))]
    bn.zuordnen([kalender], blocks)
    assert kalender.credit is None


def test_nachweis_im_falschen_format_zaehlt_ueber_den_text():
    """Greim: "Foto: Harald Jaudas" im Format "zwischen Titel"."""
    kreuz = bild(0.7053, 0.0052, 1.0, 0.2609, "ritterkreuz.tif")
    blocks = [nachweis("Foto: Harald Jaudas", (0.9592, 0.1322, 0.9811, 0.2102), stil="1 zwischen Titel  11,5/5", kind="subheading")]
    bn.zuordnen([kreuz], blocks)
    assert kreuz.credit == "Foto: Harald Jaudas"


def test_lesetext_der_mit_foto_beginnt_ist_kein_nachweis():
    foto = bild(0.3, 0.1, 0.6, 0.3)
    text = "Foto: Das Bild zeigt " + "einen langen Absatz im Mengentext, " * 10
    blocks = [nachweis(text, (0.3, 0.302, 0.6, 0.4), stil="Mengentext 2023", kind="paragraph")]
    bn.zuordnen([foto], blocks)
    assert foto.credit is None


def test_zwei_nachweise_an_einer_montage():
    """ZUERST! 6/2025 S. 8: links und rechts an der Montage, beide gehoeren ihr."""
    montage = bild(0.0476, 0.0606, 0.9524, 0.3704, "montage zielgruppen.tif")
    blocks = [
        nachweis("Foto: Wikimedia/Raimond Spekking/CC BY-SA 4.0", (0.9543, 0.202, 0.9686, 0.3704), rahmen="a"),
        nachweis("Foto: Gemeinfrei", (0.0381, 0.2357, 0.0524, 0.3704), rahmen="b"),
    ]
    bn.zuordnen([montage], blocks)
    assert "Raimond Spekking" in montage.credit and "Gemeinfrei" in montage.credit


def test_satzbilder_setzt_unterschrift_und_nachweis():
    """Der Worker-Weg: `unterschriften_zuordnen` setzt beides, Unterschrift ohne Nachweis."""
    foto = bild(0.667, 0.66, 0.952, 0.909, "ManuOster.tif")
    blocks = [
        SourceBlock(
            page_index=0, text="Der Vizechef der Bundespolizeigewerkschaft Manuel Ostermann.",
            x0=0.667, y0=0.85, x1=0.952, y1=0.909, kind="caption", origin="idml",
            story_id="s-u", frame_id="u", style_name="Bildunterschrift weiß",
            frame_box=(0.667, 0.85, 0.952, 0.909),
        ),
        nachweis("Foto: Wikimedia/Manuel Ostermann/CC BY-SA 4.0", (0.954, 0.801, 0.969, 0.936)),
    ]
    unterschriften_zuordnen([foto], blocks)
    assert foto.caption.startswith("Der Vizechef")
    assert "Foto:" not in foto.caption
    assert foto.credit == "Foto: Wikimedia/Manuel Ostermann/CC BY-SA 4.0"
