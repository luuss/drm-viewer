"""Bildunterschriften nach der Satzstruktur (extractor/bildunterschriften.py).

Die Lagen sind aus echten Seiten nachgebaut (Koordinaten auf die Seite
normiert, y von oben). Zu jeder Regel ein Fall, in dem sie greift, und einer,
in dem sie nicht greift.
"""
import io
import zipfile

from extractor import bildunterschriften as bu
from extractor.idml_articles import Story, ohne_unterlagen, zeilen_zusammenfuehren
from extractor.idml_extract import extract_idml_blocks, extract_idml_frames, frames_to_images
from extractor.model import SourceBlock, SourceImage


def bild(x0, y0, x1, y1, link="foto.tif", seite=0, gruppen=(), teile=()):
    return SourceImage(
        page_index=seite, x0=x0, y0=y0, x1=x1, y1=y1, link=link, groups=gruppen,
        spread_parts=teile,
    )


def bu_block(text, box, seite=0, rahmen="f1", gruppen=(), nach_leer=False, stil="Bildunterschrift weiß"):
    return SourceBlock(
        page_index=seite, text=text, x0=box[0], y0=box[1], x1=box[2], y1=box[3],
        kind="caption", origin="idml", story_id="s-" + rahmen, frame_id=rahmen,
        style_name=stil, frame_box=box, frame_groups=gruppen, after_blank=nach_leer,
    )


# --- ZUERST! 6/2025 S. 34: weisse Unterschrift auf dem Foto -----------------

def test_unterschrift_auf_dem_foto_gehoert_zum_foto():
    schueler = bild(0.048, 0.754, 0.643, 1.0, "IMG_2460.tif")
    portraet = bild(0.667, 0.061, 0.952, 0.357, "KHA6574.tif")
    text = "Bürgermeister Laurens Nothdurft (rechts) mit Roßlauer Schülern am 8. Mai."
    blocks = [bu_block(text, (0.048, 0.754, 0.359, 0.788))]
    bu.zuordnen([portraet, schueler], blocks)
    assert schueler.caption == text
    assert portraet.caption is None


def test_alte_naeheregel_verlor_die_unterschrift_auf_dem_foto():
    """Gegenprobe: die PDF-Regel sucht nur unter dem Bild und findet nichts."""
    from extractor.pdf_extract import attach_captions

    schueler = bild(0.048, 0.754, 0.643, 1.0)
    attach_captions([schueler], [bu_block("Bürgermeister mit Schülern.", (0.048, 0.754, 0.359, 0.788))])
    assert schueler.caption is None


# --- unter, ueber, neben ----------------------------------------------------

def test_unterschrift_unter_dem_bild_und_nicht_beim_nachbarn():
    oben = bild(0.357, 0.061, 0.952, 0.333)
    links = bild(0.048, 0.061, 0.333, 0.384)
    blocks = [bu_block("Frundsbergfest in Mindelheim.", (0.61, 0.333, 0.952, 0.384))]
    bu.zuordnen([links, oben], blocks)
    assert oben.caption == "Frundsbergfest in Mindelheim."
    assert links.caption is None


def test_richtungswort_links_zeigt_auf_das_bild_links():
    """ZUERST! 2/2025 S. 61: zwei Unterschriften unter dem rechten Foto."""
    links = bild(0.048, 0.061, 0.333, 0.384, "fenster.tif")
    rechts = bild(0.357, 0.061, 0.952, 0.333, "umzug.tif")
    blocks = [
        bu_block("Links: Fenster mit Darstellung Georg von Frundsbergs.", (0.357, 0.333, 0.594, 0.384), rahmen="a"),
        bu_block("Beim Frundsbergfest in Mindelheim.", (0.61, 0.333, 0.952, 0.384), rahmen="b"),
    ]
    bu.zuordnen([links, rechts], blocks)
    assert links.caption.startswith("Links: Fenster")
    assert rechts.caption.startswith("Beim Frundsbergfest")


def test_unterschrift_neben_dem_bild_in_der_nachbarspalte():
    """DMZ-Zeitgeschichte 80 S. 39: Rahmen ragt ein Stueck ins Foto."""
    foto = bild(0.042, 0.465, 0.539, 0.929)
    blocks = [bu_block("Karl Rettlinger nach der Verleihung.", (0.486, 0.849, 0.952, 0.93))]
    bu.zuordnen([foto], blocks)
    assert foto.caption == "Karl Rettlinger nach der Verleihung."


def test_ferner_kleintext_wird_keine_unterschrift():
    foto = bild(0.048, 0.061, 0.643, 0.33)
    blocks = [bu_block("Irgendwo weiter unten.", (0.048, 0.6, 0.333, 0.64))]
    ergebnis = bu.zuordnen([foto], blocks)
    assert foto.caption is None
    assert ergebnis[0][2] == "keins"


def test_rahmen_halb_im_tweet_bild_gehoert_zum_foto_darueber():
    """ZUERST! 2/2025 S. 23: der breite Rahmen ragt in das eingeklinkte Bild."""
    foto = bild(0.357, 0.377, 0.952, 0.626, "conversation.tif")
    tweet = bild(0.349, 0.609, 0.695, 0.672, "only the afd.tif")
    blocks = [bu_block("Stein des Anstoßes: Alice Weidel und Elon Musk.", (0.357, 0.626, 0.952, 0.667))]
    bu.zuordnen([foto, tweet], blocks)
    assert foto.caption.startswith("Stein des Anstoßes")
    assert tweet.caption is None


def test_detailaufnahme_im_grossen_bild_bekommt_ihre_unterschrift():
    """DMZ 170 S. 17: Unterschrift unter dem Stempel-Detail, beides auf der Waffe."""
    waffe = bild(0.0, 0.578, 0.994, 0.945, "EMP44_links.tif")
    detail = bild(0.398, 0.795, 0.735, 0.875, "stempel.tif")
    blocks = [bu_block("Trotz der Modellbezeichnung ...", (0.4, 0.886, 0.738, 0.93))]
    bu.zuordnen([waffe, detail], blocks)
    assert detail.caption == "Trotz der Modellbezeichnung ..."
    assert waffe.caption is None


def test_gestaffelte_blaetter_vorderstes_buendiges_bekommt_sie():
    """DMZ-Zeitgeschichte 80 S. 32: drei Seiten eines Dokuments uebereinander."""
    s1 = bild(0.026, 0.284, 0.471, 0.715, "Seite 1.tif", gruppen=("g",))
    s3 = bild(0.113, 0.294, 0.556, 0.723, "Seite 3.tif", gruppen=("g",))
    s4 = bild(0.167, 0.283, 0.657, 0.734, "Seite 4.tif", gruppen=("g",))
    blocks = [bu_block("Vorschlag für die Verleihung.", (0.047, 0.711, 0.487, 0.765), gruppen=("g",))]
    bu.zuordnen([s4, s1, s3], blocks)
    assert s1.caption == "Vorschlag für die Verleihung."


# --- Gruppe -----------------------------------------------------------------

def test_gruppe_schlaegt_die_naehe():
    eigenes = bild(0.312, 0.18, 0.958, 0.463, gruppen=("g1",))
    fremdes = bild(0.312, 0.52, 0.958, 0.8)
    # Die Unterschrift steht naeher am fremden Bild, ist aber mit dem eigenen gruppiert.
    blocks = [bu_block("Greim an der Flak.", (0.312, 0.469, 0.951, 0.517), gruppen=("g1",))]
    bu.zuordnen([eigenes, fremdes], blocks)
    assert eigenes.caption == "Greim an der Flak."
    assert fremdes.caption is None


# --- Rahmen mit zwei Unterschriften, Zeilen, zwei an einem Bild -------------

def test_leerzeile_trennt_zwei_unterschriften_im_selben_rahmen():
    """ZUERST! 3/2026 S. 57: ein Rahmen zwischen zwei Fotos."""
    oben = bild(0.357, 0.061, 0.952, 0.33)
    unten = bild(0.357, 0.39, 0.952, 0.65)
    box = (0.357, 0.33, 0.952, 0.39)
    blocks = [
        bu_block("Aufnahme von Versuchsfahrten in Monza 1955 mit dem", box),
        bu_block("Formel-1-Rennwagen W 196 R.", box),
        bu_block("Hans Herrmann mit seinen Mannschaftskollegen,", box, nach_leer=True),
        bu_block("Fangio und Kling (v.l.).", box),
    ]
    bu.zuordnen([oben, unten], blocks)
    assert oben.caption == "Aufnahme von Versuchsfahrten in Monza 1955 mit dem Formel-1-Rennwagen W 196 R."
    assert unten.caption == "Hans Herrmann mit seinen Mannschaftskollegen, Fangio und Kling (v.l.)."


def test_leerzeile_mitten_im_satz_trennt_nicht():
    box = (0.357, 0.6, 0.952, 0.66)
    foto = bild(0.357, 0.3, 0.952, 0.6)
    blocks = [
        bu_block("Hinterlassenschaft des Sozialismus: Vor allem auf viele", box),
        bu_block("Mitteldeutsche wirkt der Brückenschlag fremd.", box, nach_leer=True),
    ]
    ergebnis = bu.zuordnen([foto], blocks)
    assert len(ergebnis) == 1
    assert foto.caption.endswith("auf viele Mitteldeutsche wirkt der Brückenschlag fremd.")


def test_umbrochene_zeilen_sind_eine_unterschrift():
    """ZUERST! 6/2025 S. 35: drei Zeilen, frueher kam nur die erste an."""
    marke = bild(0.339, 0.848, 0.659, 0.949, "Briefmarke.tif")
    box = (0.667, 0.899, 0.952, 0.943)
    blocks = [
        bu_block("Durch die Zwangskollektivierung", box, stil="Bildunterschrift schwarz"),
        bu_block("wurde vielen Kleinbauern in der DDR", box, stil="Bildunterschrift schwarz"),
        bu_block("ihre Lebensgrundlage genommen.", box, stil="Bildunterschrift schwarz"),
    ]
    bu.zuordnen([marke], blocks)
    assert marke.caption == (
        "Durch die Zwangskollektivierung wurde vielen Kleinbauern in der DDR "
        "ihre Lebensgrundlage genommen."
    )


def test_zweite_unterschrift_am_selben_bild_haengt_sich_an():
    """ZUERST! 3/2025 S. 14: Unterschrift ueber der Grafik und eine darin."""
    grafik = bild(0.357, 0.424, 0.952, 0.687)
    blocks = [
        bu_block("Statt Bunkeranlagen plädieren einige für Raketenabwehr.", (0.357, 0.387, 0.952, 0.424), rahmen="a"),
        bu_block("Luftabwehr durch Flugabwehrraketensystem", (0.357, 0.433, 0.941, 0.449), rahmen="b"),
    ]
    bu.zuordnen([grafik], blocks)
    assert grafik.caption == (
        "Statt Bunkeranlagen plädieren einige für Raketenabwehr. "
        "Luftabwehr durch Flugabwehrraketensystem"
    )


def test_bildnachweis_wird_keine_unterschrift():
    foto = bild(0.1, 0.1, 0.5, 0.4)
    bu.zuordnen([foto], [bu_block("Foto: Privat", (0.1, 0.4, 0.5, 0.42))])
    assert foto.caption is None


def test_lange_unterschrift_bleibt_ganz():
    foto = bild(0.064, 0.342, 0.559, 0.918)
    text = "Das Grab von Jan Delbaere. " * 30
    bu.zuordnen([foto], [bu_block(text.strip(), (0.514, 0.709, 0.953, 0.926))])
    assert foto.caption == text.strip()


def test_unterschrift_auf_der_nachbarseite_der_doppelseite():
    """DMZ 170 S. 16: das Waffenfoto liegt mit der Mitte auf S. 17."""
    waffe = bild(0.0, 0.3, 1.0, 0.7, seite=14, teile=((13, 0.0, 0.3, 1.0, 0.7),))
    blocks = [bu_block("Seitenansichten der Erma EMP 44", (0.267, 0.617, 0.648, 0.638), seite=13)]
    bu.zuordnen([waffe], blocks)
    assert waffe.caption == "Seitenansichten der Erma EMP 44"


# --- Kasten im Unterschriftformat -------------------------------------------

class _Rahmen:
    def __init__(self, seite, x0, y0, x1, y1):
        self.page_number, self.x0, self.y0, self.x1, self.y1 = seite, x0, y0, x1, y1


def test_unterschriftformat_um_ein_foto_ist_ein_kasten():
    """ZUERST! 3/2025 S. 13: "Szenario 2" im Format "Bildunterschrift schwarz"."""
    kasten = bu_block("Szenario 2: Zivile Unruhen", (0.357, 0.7, 0.952, 0.936), rahmen="k")
    echte = bu_block("Der Leiter des Sanitätsdienstes.", (0.543, 0.431, 0.952, 0.475), rahmen="e")
    rahmen = [_Rahmen(0, 0.686, 0.709, 0.938, 0.828), _Rahmen(0, 0.357, 0.431, 0.952, 0.687)]
    gefunden = bu.kaesten_im_unterschriftformat(rahmen, [kasten, echte])
    assert gefunden == {"s-k"}
    bu.als_kasten([kasten, echte], gefunden)
    assert kasten.kind == "box" and echte.kind == "caption"
    assert Story("s-k", [kasten]).rolle() == "kasten"
    assert Story("s-e", [echte]).rolle() == "bildunterschrift"


# --- Satzdatei: freigestelltes Bild, Gruppe, Doppelseite --------------------

SEITE_B, SEITE_H = 595.276, 841.89


def _rechteck(self_id, l, o, r, u, datei, kontur=""):
    punkte = "".join(
        f'<PathPointType Anchor="{x} {y}" LeftDirection="{x} {y}" RightDirection="{x} {y}"/>'
        for x, y in ((l, o), (l, u), (r, u), (r, o))
    )
    return (
        f'<Rectangle Self="{self_id}" ItemTransform="1 0 0 1 0 0">'
        '<Properties><PathGeometry><GeometryPathType PathOpen="false">'
        f"<PathPointArray>{punkte}</PathPointArray>"
        "</GeometryPathType></PathGeometry></Properties>"
        f'<Image Self="i{self_id}" ItemTransform="0.25 0 0 0.25 {l} {o}">{kontur}'
        f'<Link Self="l{self_id}" LinkResourceURI="file:/Links/{datei}"/>'
        "</Image></Rectangle>"
    )


def _kontur():
    # Konturfuehrung des freigestellten Bildes, im System des Bildes: weit
    # ausserhalb des Rahmens, wenn man sie mit dessen Matrix rechnet.
    punkte = "".join(
        f'<PathPointType Anchor="{x} {y}" LeftDirection="{x} {y}" RightDirection="{x} {y}"/>'
        for x, y in ((-30, 5000), (500, 5000), (500, 6000))
    )
    return (
        '<Properties><TextWrapPreference><Properties><PathGeometry><GeometryPathType>'
        f"<PathPointArray>{punkte}</PathPointArray>"
        "</GeometryPathType></PathGeometry></Properties></TextWrapPreference></Properties>"
    )


def _textrahmen(self_id, story, l, o, r, u):
    punkte = "".join(
        f'<PathPointType Anchor="{x} {y}" LeftDirection="{x} {y}" RightDirection="{x} {y}"/>'
        for x, y in ((l, o), (l, u), (r, u), (r, o))
    )
    return (
        f'<TextFrame Self="{self_id}" ParentStory="{story}" ItemTransform="1 0 0 1 0 0">'
        '<Properties><PathGeometry><GeometryPathType PathOpen="false">'
        f"<PathPointArray>{punkte}</PathPointArray>"
        "</GeometryPathType></PathGeometry></Properties></TextFrame>"
    )


def _idml():
    """Doppelseite: links ein gruppiertes freigestelltes Wappen mit Unterschrift,
    ein Foto ueber den Bund, das mit der Mitte auf der rechten Seite liegt."""
    seiten = (
        f'<Page Self="p1" GeometricBounds="0 0 {SEITE_H} {SEITE_B}" '
        f'ItemTransform="1 0 0 1 {-SEITE_B} {-SEITE_H / 2}"/>'
        f'<Page Self="p2" GeometricBounds="0 0 {SEITE_H} {SEITE_B}" '
        f'ItemTransform="1 0 0 1 0 {-SEITE_H / 2}"/>'
    )
    oben = -SEITE_H / 2
    wappen = _rechteck("w", -140, oben + 240, -30, oben + 400, "Wappen - frei.tif", _kontur())
    unterschrift = _textrahmen("t1", "sbu", -140, oben + 405, -30, oben + 430)
    gruppe = f'<Group Self="g1" ItemTransform="1 0 0 1 0 0">{wappen}{unterschrift}</Group>'
    ueber_den_bund = _rechteck("b", -200, oben + 500, 500, oben + 700, "bund.tif")
    spread = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">'
        f'<Spread Self="sp" ItemTransform="1 0 0 1 0 0">{seiten}{gruppe}{ueber_den_bund}</Spread>'
        "</idPkg:Spread>"
    )
    story = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">'
        '<Story Self="sbu"><ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Bildunterschrift DMZ 2023">'
        "<CharacterStyleRange><Content>Das Wappen Wallensteins</Content></CharacterStyleRange>"
        "</ParagraphStyleRange></Story></idPkg:Story>"
    )
    designmap = (
        '<?xml version="1.0"?>'
        '<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">'
        '<idPkg:Spread src="Spreads/Spread_sp.xml"/></Document>'
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("designmap.xml", designmap)
        zf.writestr("Spreads/Spread_sp.xml", spread)
        zf.writestr("Stories/Story_sbu.xml", story)
    return buf.getvalue()


def test_freigestelltes_bild_behaelt_seinen_rahmen():
    """DMZ 170 S. 70: die Konturfuehrung blaehte den Rahmen auf, das Wappen fiel weg."""
    bilder, _texte = extract_idml_frames(_idml())
    wappen = [b for b in bilder if b.link == "Wappen - frei.tif"]
    assert len(wappen) == 1
    w = wappen[0]
    assert w.page_number == 0
    assert 0.7 < w.x0 < w.x1 < 0.96 and 0.25 < w.y0 < w.y1 < 0.5


def test_gruppe_und_unterschrift_aus_der_satzdatei():
    data = _idml()
    bilder, texte = extract_idml_frames(data)
    blocks = extract_idml_blocks(data, texte)
    assert [t.gruppen for t in texte] == [("g1",)]
    pm = [(0, 0), (1, 1)]
    images = frames_to_images(bilder, pm, {}, min_area=0)
    bu.zuordnen(images, blocks)
    wappen = next(i for i in images if i.link == "Wappen - frei.tif")
    assert wappen.groups == ("g1",)
    assert wappen.caption == "Das Wappen Wallensteins"


def test_bild_ueber_den_bund_kennt_seinen_teil_auf_der_nachbarseite():
    bilder, _ = extract_idml_frames(_idml())
    bund = next(b for b in bilder if b.link == "bund.tif")
    assert bund.page_number == 1
    assert [t[0] for t in bund.auslaeufer] == [0]
    images = frames_to_images([bund], [(0, 10), (1, 11)], {}, min_area=0)
    assert images[0].page_index == 11
    assert images[0].spread_parts[0][0] == 10


# --- Buchmodell unter dem Umschlag ------------------------------------------

def test_buchmodell_mit_58_prozent_umschlag_ist_unterlage():
    """ZUERST!-Besprechungsseiten: das leere Buchmodell faellt weg, der Umschlag bleibt."""
    class F(_Rahmen):
        def __init__(self, x0, y0, x1, y1, link):
            super().__init__(0, x0, y0, x1, y1)
            self.link = link

    modell = F(0.110, 0.053, 0.309, 0.235, "01_buch test 1.tif")
    # 0.142 x 0.150 / (0.199 x 0.182) = 0.588
    umschlag = F(0.117, 0.071, 0.259, 0.221, "cancel culture.tif")
    assert [b.link for b in ohne_unterlagen([modell, umschlag], [], {})] == ["cancel culture.tif"]


def test_aufmacher_mit_eingeklinktem_bild_bleibt():
    class F(_Rahmen):
        def __init__(self, x0, y0, x1, y1, link):
            super().__init__(0, x0, y0, x1, y1)
            self.link = link

    gross = F(0.0, 0.0, 1.0, 0.5, "laptop.tif")
    # 46 Prozent wie beim Laptop mit Bildschirmfoto (ZUERST! S. 80)
    klein = F(0.1, 0.05, 0.78, 0.39, "bildschirm.tif")
    assert len(ohne_unterlagen([gross, klein], [], {})) == 2


# --- Zeilen und Anrede (Editorial) -------------------------------------------

def _zeile(text, stil, story="s", seite=0):
    return SourceBlock(page_index=seite, text=text, x0=0, y0=0, x1=1, y1=0.1, origin="idml",
                       story_id=story, style_name=stil)


def test_anrede_im_editorial_wird_eine_zeile():
    """DMZ 170 S. 3: "Verehrter" / "Leser," standen als zwei Absaetze im Lesetext."""
    blocks = [
        _zeile("Verehrter", "$ID/NormalParagraphStyle"),
        _zeile("Leser,", "$ID/NormalParagraphStyle"),
        _zeile("kaum ist das Jahr 2025 zur Neige gegangen.", "Mengentext 2023"),
        _zeile("Mit freundlichen Grüßen", "Mengentext 2023"),
        _zeile("Ihr", "Mengentext 2023"),
    ]
    assert [b.text for b in zeilen_zusammenfuehren(blocks)] == [
        "Verehrter Leser,",
        "kaum ist das Jahr 2025 zur Neige gegangen.",
        "Mit freundlichen Grüßen",
        "Ihr",
    ]


def test_umbrochene_zwischenzeile_wird_eine_zeile_verfasser_und_titel_nicht():
    blocks = [
        _zeile("„Man sah von Paris", "Zwischenüberschrift rot"),
        _zeile("und London aus kühl zu.“", "Zwischenüberschrift rot"),
        _zeile("Stefan Scheil/Robert Owen", "Hauptüberschrift", story="t"),
        _zeile("Die russische Verschwörung", "Hauptüberschrift", story="t"),
    ]
    assert [b.text for b in zeilen_zusammenfuehren(blocks)] == [
        "„Man sah von Paris und London aus kühl zu.“",
        "Stefan Scheil/Robert Owen",
        "Die russische Verschwörung",
    ]


def test_titelnachweis_neben_dem_editorial_ist_beiwerk():
    nachweis = _zeile(
        "Titelseite: Deutsche Elite hinter feindlichen Linien – die Fernspäher. Foto: DMZ-Archiv",
        "Mengentext 2023",
    )
    assert Story("s", [nachweis]).rolle() == "beiwerk"
    normal = _zeile("Titelseiten großer Zeitungen zeigten am Montag das Bild. " * 3, "Mengentext 2023")
    assert Story("s", [normal]).rolle() == "mengentext"
