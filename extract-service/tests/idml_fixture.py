"""Eine kleine, echte IDML-Datei erzeugen.

Fuer das Musterheft liegt kein IDML-Export vor. Damit der Weg trotzdem geprueft
werden kann, baut dieses Modul ein Archiv mit derselben Struktur, die InDesign
schreibt: `designmap.xml` bestimmt die Reihenfolge der Druckbogen, jeder Bogen
enthaelt seine Seiten mit `GeometricBounds` und `ItemTransform`, und die
Bildrahmen sind Rechtecke mit Ankerpunkten und einem `Image`-Kind.

Der zweite Bogen ist bewusst eine Doppelseite: nur daran zeigt sich, ob die
Zuordnung Rahmen zu Seite ueber den Bogen hinweg stimmt.
"""
import io, zipfile

SEITE_B, SEITE_H = 595.276, 841.89

def spread(self_id, seiten, rahmen):
    """seiten: [(name, tx)], rahmen: [(seite_tx, links, oben, rechts, unten, datei)]"""
    teile = [f'<?xml version="1.0" encoding="UTF-8"?>',
             '<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">',
             f'<Spread Self="{self_id}" ItemTransform="1 0 0 1 0 0">']
    for name, tx in seiten:
        teile.append(
            f'<Page Self="p{name}" Name="{name}" '
            f'GeometricBounds="0 0 {SEITE_H} {SEITE_B}" '
            f'ItemTransform="1 0 0 1 {tx} {-SEITE_H/2}"/>' )
    for i, (tx, l, o, r, u, datei) in enumerate(rahmen):
        # Rahmen im eigenen System um den Mittelpunkt, ItemTransform schiebt ihn
        # an seinen Platz im Bogen — genau wie InDesign es schreibt.
        cx, cy = (l + r) / 2, (o + u) / 2
        hw, hh = (r - l) / 2, (u - o) / 2
        punkte = "".join(
            f'<PathPointType Anchor="{x} {y}" LeftDirection="{x} {y}" RightDirection="{x} {y}"/>'
            for x, y in ((-hw, -hh), (-hw, hh), (hw, hh), (hw, -hh))
        )
        teile.append(
            f'<Rectangle Self="r{i}" ItemTransform="1 0 0 1 {tx + cx} {cy - SEITE_H/2}">'
            '<Properties><PathGeometry><GeometryPathType PathOpen="false">'
            f'<PathPointArray>{punkte}</PathPointArray>'
            '</GeometryPathType></PathGeometry></Properties>'
            f'<Image Self="i{i}" ItemTransform="1 0 0 1 0 0">'
            f'<Link Self="l{i}" LinkResourceURI="file:/Bilder/{datei}"/>'
            '</Image></Rectangle>')
    teile.append('</Spread></idPkg:Spread>')
    return "".join(teile)

def bauen() -> bytes:
    # Bogen 1: Einzelseite (Titel), Bogen 2: Doppelseite.
    s1 = spread("sp1", [("1", 0.0)],
                [(0.0, 50.0, 100.0, 300.0, 400.0, "titel.jpg")])
    s2 = spread("sp2", [("2", -SEITE_B), ("3", 0.0)],
                [(-SEITE_B, 40.0, 60.0, 280.0, 240.0, "links.jpg"),
                 (0.0, 100.0, 500.0, 500.0, 800.0, "rechts.jpg"),
                 (0.0, 0.0, 0.0, 20.0, 20.0, "winzig.jpg")])
    designmap = ('<?xml version="1.0"?>'
                 '<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">'
                 '<idPkg:Spread src="Spreads/Spread_sp1.xml"/>'
                 '<idPkg:Spread src="Spreads/Spread_sp2.xml"/>'
                 '</Document>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("designmap.xml", designmap)
        zf.writestr("Spreads/Spread_sp1.xml", s1)
        zf.writestr("Spreads/Spread_sp2.xml", s2)
    return buf.getvalue()
