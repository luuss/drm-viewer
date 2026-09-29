"""Tabellen aus dem Satz: Zeilen, Zellen, Kopf, verbundene Zellen, Lage im Text."""
from __future__ import annotations

import io
import os
import sys
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from extractor.idml_articles import artikel_aus_satz  # noqa: E402
from extractor.idml_extract import IdmlTextFrame, extract_idml_blocks  # noqa: E402
from extractor.model import SourceBlock, TableCell, TableData  # noqa: E402

KOPF = '<?xml version="1.0" encoding="UTF-8"?><idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">'


def zelle(name: str, *absaetze: str, fill: str | None = None, farbe: str | None = None,
          schnitt: str | None = None, rows: int = 1, cols: int = 1) -> str:
    fl = f' FillColor="{fill}"' if fill else ""
    zeichen = (f' FillColor="{farbe}"' if farbe else "") + (
        f' FontStyle="{schnitt}"' if schnitt else ""
    )
    inhalt = "<Br/>".join(f"<Content>{a}</Content>" for a in absaetze)
    return (
        f'<Cell Self="c{name}" Name="{name}" RowSpan="{rows}" ColumnSpan="{cols}"{fl}>'
        '<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Tabelle">'
        f'<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"{zeichen}>'
        f"{inhalt}</CharacterStyleRange></ParagraphStyleRange></Cell>"
    )


def tabelle(zellen: list[str], *, zeilen: int, spalten: int, kopf: int = 0,
            breiten: tuple[float, ...] | None = None) -> str:
    breiten = breiten or tuple(100.0 for _ in range(spalten))
    return (
        f'<Table Self="t1" HeaderRowCount="{kopf}" FooterRowCount="0" '
        f'BodyRowCount="{zeilen - kopf}" ColumnCount="{spalten}">'
        + "".join(f'<Row Self="r{i}" Name="{i}"/>' for i in range(zeilen))
        + "".join(
            f'<Column Self="k{i}" Name="{i}" SingleColumnWidth="{b}"/>'
            for i, b in enumerate(breiten)
        )
        + "".join(zellen)
        + "</Table>"
    )


def story(self_id: str, inhalt: str) -> str:
    return f'{KOPF}<Story Self="{self_id}">{inhalt}</Story></idPkg:Story>'


def absatz(text: str, stil: str = "Mengentext 2023") -> str:
    return (
        f'<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/{stil}">'
        f"<CharacterStyleRange><Content>{text}</Content><Br/></CharacterStyleRange>"
        "</ParagraphStyleRange>"
    )


def idml(**stories: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, xml in stories.items():
            zf.writestr(f"Stories/Story_{name}.xml", xml)
    return buf.getvalue()


def rahmen(story_id: str, seite: int) -> IdmlTextFrame:
    return IdmlTextFrame(
        page_number=seite, x0=0.05, y0=0.1, x1=0.95, y1=0.9,
        story_id=story_id, self_id=f"{story_id}-r",
    )


# Eine Tabelle wie auf Seite 33 der Schwerterträger 36: keine ausgewiesene
# Kopfzeile, aber die erste Zeile rot hinterlegt und fett, eine Zeile in
# Rot hervorgehoben.
GREIM = tabelle(
    [
        zelle("0:0", "Nr.", fill="Color/Eichenlaub", farbe="Color/Paper", schnitt="Semibold"),
        zelle("1:0", "Name", fill="Color/Eichenlaub", farbe="Color/Paper", schnitt="Semibold"),
        zelle("0:1", "1"),
        zelle("1:1", "Erwin Rommel"),
        zelle("0:2", "38", fill="Color/Grau", farbe="Color/Eichenlaub"),
        zelle("1:2", "Robert von Greim", fill="Color/Grau", farbe="Color/Eichenlaub"),
    ],
    zeilen=3,
    spalten=2,
    breiten=(30.0, 90.0),
)


def test_tabelle_wird_ein_block_an_ihrer_stelle():
    inhalt = (
        absatz("Davor steht ein Absatz.")
        + '<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Mengentext 2023">'
        f"<CharacterStyleRange>{GREIM}<Br/></CharacterStyleRange></ParagraphStyleRange>"
        + absatz("Danach geht der Text weiter.")
    )
    blocks = extract_idml_blocks(idml(a=story("a", inhalt)))
    assert [b.kind for b in blocks] == ["paragraph", "table", "paragraph"]
    assert blocks[0].text == "Davor steht ein Absatz."
    assert blocks[2].text == "Danach geht der Text weiter."
    # Die Zellen stehen nicht noch einmal als Absaetze im Text.
    assert not any(b.text == "Erwin Rommel" for b in blocks)


def test_tabelle_kennt_zeilen_kopf_und_hervorhebung():
    blocks = extract_idml_blocks(
        idml(a=story("a", f'<ParagraphStyleRange><CharacterStyleRange>{GREIM}</CharacterStyleRange></ParagraphStyleRange>'))
    )
    assert len(blocks) == 1
    t = blocks[0].table
    assert t is not None
    assert t.header_rows == 1
    assert [[c.text for c in row] for row in t.rows] == [
        ["Nr.", "Name"],
        ["1", "Erwin Rommel"],
        ["38", "Robert von Greim"],
    ]
    assert all(c.header for c in t.rows[0])
    assert not any(c.header for c in t.rows[1])
    assert [c.emphasis for c in t.rows[1]] == [False, False]
    assert [c.emphasis for c in t.rows[2]] == [True, True]
    assert t.column_widths == (0.25, 0.75)
    assert blocks[0].text == "Nr. | Name\n1 | Erwin Rommel\n38 | Robert von Greim"


def test_ausgewiesene_kopfzeilen_und_verbundene_zellen():
    t = tabelle(
        [
            zelle("0:0", "Jahr", cols=2),
            zelle("2:0", "Ort"),
            zelle("0:1", "1917", rows=2),
            zelle("1:1", "Mai"),
            zelle("2:1", "Flandern", "Erste Stellung"),
            # InDesign fuehrt die verdeckte Zelle mancher Versionen mit.
            zelle("0:2", ""),
            zelle("1:2", "Juni"),
            zelle("2:2", "Arras"),
        ],
        zeilen=3,
        spalten=3,
        kopf=1,
    )
    blocks = extract_idml_blocks(
        idml(a=story("a", f"<ParagraphStyleRange><CharacterStyleRange>{t}</CharacterStyleRange></ParagraphStyleRange>"))
    )
    tab = blocks[0].table
    assert tab is not None
    assert tab.header_rows == 1
    assert [(c.text, c.col_span, c.row_span) for c in tab.rows[0]] == [
        ("Jahr", 2, 1),
        ("Ort", 1, 1),
    ]
    assert [(c.text, c.row_span) for c in tab.rows[1]] == [
        ("1917", 2),
        ("Mai", 1),
        ("Flandern\nErste Stellung", 1),
    ]
    # Die verdeckte Zelle unter "1917" faellt weg.
    assert [c.text for c in tab.rows[2]] == ["Juni", "Arras"]
    # Ohne Farbe und ohne Fett bleibt eine nicht ausgewiesene Kopfzeile Text.
    schlicht = tabelle(
        [zelle("0:0", "a"), zelle("0:1", "b")], zeilen=2, spalten=1
    )
    ohne = extract_idml_blocks(
        idml(a=story("a", f"<ParagraphStyleRange><CharacterStyleRange>{schlicht}</CharacterStyleRange></ParagraphStyleRange>"))
    )
    assert ohne[0].table is not None and ohne[0].table.header_rows == 0


def test_leere_tabelle_ist_kein_block():
    t = tabelle([zelle("0:0", ""), zelle("0:1", "")], zeilen=2, spalten=1)
    blocks = extract_idml_blocks(
        idml(a=story("a", absatz("Nur Text.") + f"<ParagraphStyleRange><CharacterStyleRange>{t}</CharacterStyleRange></ParagraphStyleRange>"))
    )
    assert [b.kind for b in blocks] == ["paragraph"]


def test_tabelle_auf_der_nachbarseite_gehoert_zum_artikel_davor():
    """Seite 33 der Greim-Ausgabe: links der Beitrag, rechts nur die Tabelle."""
    lang = "Robert Ritter von Greim ist einer von den 67 Soldaten. " * 12
    stories = idml(
        text=story("text", absatz("Pour le Mérite", "hauptüberschrift schwerter")
                   + absatz(lang, "mengentext schwerter")),
        tab=story("tab", f'<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/mengentext schwerter"><CharacterStyleRange>{GREIM}</CharacterStyleRange></ParagraphStyleRange>'),
    )
    blocks = extract_idml_blocks(stories, [rahmen("text", 4), rahmen("tab", 5)])
    artikel = artikel_aus_satz(blocks)
    # Kein eigener Artikel aus der Tabelle, sie steht hinter dem Text.
    assert len(artikel) == 1
    assert [b.kind for b in artikel[0].blocks][-1] == "table"
    assert artikel[0].pages == [4, 5]


def test_grosse_tabelle_allein_ist_kein_artikel():
    viele = [
        zelle(f"{s}:{z}", f"Eintrag {z}-{s} mit etwas Text")
        for z in range(20)
        for s in range(2)
    ]
    gross = tabelle(viele, zeilen=20, spalten=2)
    lang = "Ein langer Artikel mit ausreichend Text. " * 20
    stories = idml(
        text=story("text", absatz(lang)),
        tab=story("tab", f"<ParagraphStyleRange AppliedParagraphStyle=\"ParagraphStyle/Mengentext 2023\"><CharacterStyleRange>{gross}</CharacterStyleRange></ParagraphStyleRange>"),
    )
    blocks = extract_idml_blocks(stories, [rahmen("text", 2), rahmen("tab", 2)])
    artikel = artikel_aus_satz(blocks)
    assert len(artikel) == 1
    assert sum(1 for b in artikel[0].blocks if b.kind == "table") == 1


def test_nutzlast_fuer_convex():
    t = TableData(
        rows=(
            (TableCell("Nr.", header=True), TableCell("Name", header=True)),
            (TableCell("38", emphasis=True), TableCell("Greim", col_span=1, row_span=2)),
        ),
        header_rows=1,
        column_widths=(0.25, 0.75),
    )
    assert t.to_payload() == {
        "headerRows": 1,
        "columnWidths": [0.25, 0.75],
        "rows": [
            [{"text": "Nr.", "header": True}, {"text": "Name", "header": True}],
            [{"text": "38", "emphasis": True}, {"text": "Greim", "rowSpan": 2}],
        ],
    }
    assert t.column_count == 2


def test_tabelle_ist_nie_beiwerk():
    from extractor.pdf_extract import mark_furniture

    kurz = TableData(rows=((TableCell("1"), TableCell("2")),))
    blocks = [
        SourceBlock(page_index=p, text="1 | 2", x0=0.1, y0=0.5, x1=0.9, y1=0.6,
                    kind="table", origin="idml", table=kurz)
        for p in range(8)
    ]
    mark_furniture(blocks, 8)
    assert not any(b.drop for b in blocks)
