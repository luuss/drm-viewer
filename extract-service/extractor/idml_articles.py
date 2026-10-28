"""Artikel unmittelbar aus dem Satz bauen.

Eine InDesign-Story ist ein Textfluss: ein Artikel laeuft durch beliebig viele
verkettete Rahmen ueber beliebig viele Seiten, und die Reihenfolge der Absaetze
steht in der Datei. Damit braucht es weder ein Inhaltsverzeichnis noch eine
Schaetzung ueber Seitenbereiche, um zu wissen, wo ein Artikel anfaengt und
aufhoert: **eine Mengentext-Story ist ein Artikel**.

Ueberschrift, Unterzeile, Autor, Kaesten und Bildunterschriften stehen in
eigenen kleinen Stories. Sie werden ueber ihre Lage auf der Seite zugeordnet:
die Ueberschrift ueber dem Anfang des Mengentextes, der Kasten innerhalb der
Seiten des Artikels.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .model import AssembledArticle, SourceBlock
from .textutil import zeilen_verbinden

# Absatzformat -> Rolle. Die Reihenfolge entscheidet: das erste Stichwort,
# das im Namen vorkommt, gewinnt. Alle vier Reihen benennen ihre Formate
# sprechend ("Mengentext 2023", "hauptueberschrift schwerter"), deshalb
# reichen Stichwoerter statt einer Liste je Reihe.
ROLLEN_REGELN: tuple[tuple[tuple[str, ...], str], ...] = (
    (("bildquelle", "bildnachweis", "fotonachweis"), "quelle"),
    (("bildunterschrift", "bildtext", "legende"), "bildunterschrift"),
    # Die Seitenrubrik ("Deutschland", "Titel") steht als Marke am Seitenrand
    # und wiederholt sich auf jeder Seite des Artikels.
    (
        (
            "kolumnentitel",
            "pagina",
            "fusszeile",
            "fußzeile",
            "kopfzeile",
            "seitenrubrik",
        ),
        "beiwerk",
    ),
    (("inhaltsverzeichnis", "verzeichnis", "inhalt "), "verzeichnis"),
    # Zunge am Seitenrand, Zitatkasten: ein Blickfang, der dem Blaetternden
    # sagt, worum es auf der Seite geht. Steht vor "kasten" und "autor", damit
    # "Zitatkasten" und "Zitat Autor" hier landen.
    (("zungentext", "zitat", "quote"), "schmuckzitat"),
    # Beschriftung einer Karte oder Grafik ("Text in der Karte": Ortsnamen,
    # Prozentwerte, Achsen). Ohne die Zeichnung ist sie kein Lesetext; im
    # Artikel stand sie als zwanzig lose Absaetze ("32 %", "2025", "Madrid").
    (("text in der karte", "text in der grafik", "kartentext", "grafiktext"), "grafik"),
    (("autorenname", "autor", "verfasser", "byline"), "autor"),
    (("zwischen", "rubrikname", "dachzeile", "kicker"), "zwischentitel"),
    (
        ("unterüberschrift", "unterueberschrift", "uü ", "uu ", "unterzeile"),
        "unterzeile",
    ),
    (("einleitung", "vortext", "vorspann", "teaser", "lead"), "einleitung"),
    # "HÜ Soldatenportraet 2023" ist die Hauptueberschrift, "UÜ ..." die
    # Unterzeile darunter. Die Kurzformen sind in den Reihen ueblich.
    (("hauptüberschrift", "hauptueberschrift", "hü ", "hu ", "hü-"), "ueberschrift"),
    (("überschrift", "ueberschrift", "headline", "titelzeile"), "ueberschrift"),
    (("kasten", "klebezettel", "infobox", "vita", "text in der karte"), "kasten"),
    (("fußnote", "fussnote", "quellenangabe"), "fussnote"),
    (("leserbrief", "nachtext"), "mengentext"),
    (
        (
            "mengentext",
            "initiale",
            "grundtext",
            "fliesstext",
            "fließtext",
            "text nachrichten",
            "interview",
            "buchbesprechung",
            "bücherseite text",
            "buecherseite text",
            "katalog",
            "werbeseite text",
        ),
        "mengentext",
    ),
)

# Ohne eigenes Format ist ein Absatz Beiwerk, solange er kurz ist: der
# laufende Kolumnentitel, die Seitenzahl, die Rubrikmarke am Seitenrand.
OHNE_FORMAT = ("$id/normalparagraphstyle", "$id/[no paragraph style]", "")
BEIWERK_HOECHSTLAENGE = 120
# So viel Text braucht eine Story, um als eigener Artikel zu gelten. Darunter
# ist sie ein Kasten, eine Bildunterschrift oder ein Rest.
ARTIKEL_MINDESTZEICHEN = 400
# Eine Buchanzeige ist auch darunter ein eigener Artikel: Verfasser, Titel und
# drei Saetze mit Umfang und Preis ("Bücher gegen den Zeitgeist", fuenfzehn
# Buecher je Seite) kommen auf 250 bis 350 Zeichen. Ohne eigenen Artikel
# gingen sie auf einer reinen Anzeigenseite ganz verloren.
ANZEIGE_MINDESTZEICHEN = 150
# Verfasser und Titel einer Anzeige stehen oft in eigenen Rahmen ohne
# Absatzformat ueber der Beschreibung ("Stefan Scheil/Robert Owen / Die
# russische Verschwörung"). Sie gehoeren dazu, wenn sie fast buendig darueber
# in derselben Spalte stehen (Anteil der Seitenhoehe; im Satz 0,7 bis 1,1 %).
# Der Kopf einer Anzeigenseite ("großer deutscher Soldaten", 2,5 % darueber)
# oder einer Gruppe ("Unser Kalenderprogramm", ueber sechs Spalten) nicht.
TITELRAHMEN_LUECKE = 0.015
TITELRAHMEN_UEBERLAPPUNG = 0.01
TITELRAHMEN_BREITE = 1.5
TITELRAHMEN_HOECHSTZAHL = 3
# Umfang einer Buchbeschreibung ("400 S.,", "256 Seiten,"); mit einem Preis
# daneben ist der Text ein Buchangebot.
_UMFANG = re.compile(r"(?<![\d.,])(?:\d{2,3}|\d\.\d{3})\s?(?:S\.|Seiten)\s?,")


def rolle_fuer(style: str | None, text_laenge: int = 0) -> str:
    """Rolle eines Absatzes aus seinem Absatzformat."""
    name = (style or "").lower().replace("_", " ").replace("-", " ")
    for stichwoerter, rolle in ROLLEN_REGELN:
        if any(w in name for w in stichwoerter):
            return rolle
    if name in OHNE_FORMAT:
        return "beiwerk" if text_laenge <= BEIWERK_HOECHSTLAENGE else "mengentext"
    return "mengentext"


# Ein Bildrahmen, in dem ein Textrahmen steckt, ist dessen Unterlage: der
# gelbe Klebezettel hinter dem Kasten, das Kalenderblatt hinter dem Datum, das
# Logo hinter der Fusszeile. Als Artikelbild taugt er nicht — er ist leer.
UNTERLAGE_ANTEIL = 0.30
# Nur Beiwerk verraet eine Unterlage. Steht Mengentext oder eine Ueberschrift
# im Bild, ist es ein Aufmacherfoto mit Text darauf und bleibt.
UNTERLAGE_ROLLEN = (
    "kasten",
    "schmuckzitat",
    "beiwerk",
    "zwischentitel",
    "quelle",
    "autor",
)
# Dasselbe gilt fuer ein Bild im Bild: der Papierrahmen mit Buettenrand um das
# Foto, das Buchmodell unter dem Umschlag. Als eigenes Artikelbild zeigt die
# Unterlage das Foto ein zweites Mal — oder, aus der verknuepften Datei, nur
# den leeren Rahmen. An den vier Musterheften gemessen fuellt das Foto seinen
# Rahmen zu 73 bis 88 Prozent; ein Aufmacher mit eingeklinktem Bild kommt auf
# hoechstens 46.
BILD_UNTERLAGE_ANTEIL = 0.60
BILD_UNTERLAGE_RAND = 0.01


def _steckt_drin(bild, text, rand: float = 0.004) -> float:
    """Flaechenanteil des Textrahmens, wenn er ganz im Bildrahmen liegt."""
    if not (
        text.x0 >= bild.x0 - rand
        and text.y0 >= bild.y0 - rand
        and text.x1 <= bild.x1 + rand
        and text.y1 <= bild.y1 + rand
    ):
        return 0.0
    flaeche = (bild.x1 - bild.x0) * (bild.y1 - bild.y0)
    if flaeche <= 0:
        return 0.0
    return ((text.x1 - text.x0) * (text.y1 - text.y0)) / flaeche


def ohne_unterlagen(bildrahmen: list, textrahmen: list, rollen: dict) -> list:
    """Schmuckflaechen aussortieren, bevor daraus Artikelbilder werden.

    Gemessen an den vier Musterheften trifft das genau den Klebezettel, das
    Kalenderblatt, den Zierstern und das Fusszeilenlogo — zusammen 43 von 966
    Bildrahmen. Fotos mit Text darauf bleiben, weil dort Mengentext im Rahmen
    steht und nicht Beiwerk.

    Danach faellt weg, was nur ein anderes Bild einfasst (siehe
    `BILD_UNTERLAGE_ANTEIL`): in DMZ-Zeitgeschichte 80 sind das 35 Rahmen, in
    den anderen drei Heften keiner.
    """
    je_seite: dict[int, list] = {}
    for t in textrahmen:
        je_seite.setdefault(t.page_number, []).append(t)
    behalten = []
    for bild in bildrahmen:
        unterlage = any(
            _steckt_drin(bild, t) >= UNTERLAGE_ANTEIL
            and rollen.get(t.story_id) in UNTERLAGE_ROLLEN
            for t in je_seite.get(bild.page_number, [])
        )
        if not unterlage:
            behalten.append(bild)
    return [b for b in behalten if not _fasst_bild_ein(b, behalten)]


# Die Vorschau aufs naechste Heft: "Die nächste Ausgabe der Schwerterträger
# ist am 19. Juni 2026 im Handel", daneben dessen Titelbild.
VORSCHAU = re.compile(r"\bn[äa]chste\b.{0,60}\bim\s+Handel", re.I | re.S)
VORSCHAU_ABSTAND = 0.03


def ohne_vorschaubilder(bildrahmen: list, textrahmen: list, blocks: list[SourceBlock]) -> list:
    """Das Titelbild des naechsten Hefts ist kein Artikelbild.

    Es steht an der Ankuendigung, meist auf der Impressumseite; ohne diese
    Regel bekam es der Artikel, dessen Text in derselben Spalte endet
    ("Jagdflieger 1914/18" im Schwertertraeger 36).
    """
    vorschau = {s.story_id for s in stories_bilden(blocks) if VORSCHAU.search(_text(s))}
    if not vorschau:
        return bildrahmen
    kaesten = [t for t in textrahmen if t.story_id in vorschau]

    def an_vorschau(bild) -> bool:
        for t in kaesten:
            if t.page_number != bild.page_number:
                continue
            breite = min(t.x1 - t.x0, bild.x1 - bild.x0)
            if breite <= 0 or min(t.x1, bild.x1) - max(t.x0, bild.x0) < breite / 2:
                continue
            if max(t.y0 - bild.y1, bild.y0 - t.y1) <= VORSCHAU_ABSTAND:
                return True
        return False

    return [b for b in bildrahmen if not an_vorschau(b)]


def _flaeche(rahmen) -> float:
    return max(0.0, rahmen.x1 - rahmen.x0) * max(0.0, rahmen.y1 - rahmen.y0)


def _fasst_bild_ein(bild, alle: list) -> bool:
    """Liegt ein kleineres Bild im Rahmen und fuellt ihn weitgehend aus?

    Nur der groessere von beiden ist Unterlage. Zwei deckungsgleiche Rahmen
    bleiben deshalb beide stehen; dass sie dasselbe zeigen, merkt der Worker
    am fertigen Bild.
    """
    flaeche = _flaeche(bild)
    return any(
        anderes is not bild
        and anderes.page_number == bild.page_number
        and _flaeche(anderes) < flaeche
        and _steckt_drin(bild, anderes, BILD_UNTERLAGE_RAND) >= BILD_UNTERLAGE_ANTEIL
        for anderes in alle
    )


def rollen_je_story(blocks: list[SourceBlock]) -> dict[str, str]:
    """Rolle jeder Story — fuer Aufrufer, die nur die Zuordnung brauchen."""
    return {s.story_id: s.rolle() for s in stories_bilden(blocks)}


@dataclass
class Story:
    """Alle Absaetze einer Story, in der Reihenfolge des Satzes."""

    story_id: str
    blocks: list[SourceBlock] = field(default_factory=list)

    @property
    def zeichen(self) -> int:
        return sum(len(b.text) for b in self.blocks)

    @property
    def textzeichen(self) -> int:
        """Zeichen ohne Tabellen: eine Tabelle allein macht keinen Artikel."""
        return sum(len(b.text) for b in self.blocks if b.kind != "table")

    @property
    def seiten(self) -> list[int]:
        return sorted({b.page_index for b in self.blocks})

    @property
    def erste_seite(self) -> int:
        return min((b.page_index for b in self.blocks), default=0)

    @property
    def oben(self) -> float:
        """Oberkante des ersten Rahmens — fuer 'was steht darueber'."""
        erste = [b for b in self.blocks if b.page_index == self.erste_seite]
        kaesten = [b.frame_box for b in erste if b.frame_box]
        if kaesten:
            return min(k[1] for k in kaesten)
        return min((b.y0 for b in erste), default=0.0)

    @property
    def links(self) -> float:
        erste = [b for b in self.blocks if b.page_index == self.erste_seite]
        kaesten = [b.frame_box for b in erste if b.frame_box]
        if kaesten:
            return min(k[0] for k in kaesten)
        return min((b.x0 for b in erste), default=0.0)

    @property
    def rahmen(self) -> tuple[float, float, float, float]:
        """Umriss aller Rahmen auf der ersten Seite."""
        erste = [b for b in self.blocks if b.page_index == self.erste_seite]
        kaesten = [b.frame_box or (b.x0, b.y0, b.x1, b.y1) for b in erste]
        if not kaesten:
            return (0.0, 0.0, 0.0, 0.0)
        return (
            min(k[0] for k in kaesten),
            min(k[1] for k in kaesten),
            max(k[2] for k in kaesten),
            max(k[3] for k in kaesten),
        )

    def rolle(self) -> str:
        """Rolle der Story: die Rolle mit den meisten Zeichen."""
        gewicht: dict[str, int] = {}
        for b in self.blocks:
            r = rolle_fuer(b.style_name, len(b.text))
            gewicht[r] = gewicht.get(r, 0) + len(b.text)
        if not gewicht:
            return "beiwerk"
        return max(gewicht.items(), key=lambda kv: kv[1])[0]


# Ein Anfangsbuchstabe steht oft in einem eigenen kleinen Rahmen neben dem
# Text ("F" vor "ridolin Rudolf ..."). Im Satz ist er eine eigene Story.
INITIALE_HOECHSTLAENGE = 2


def _ist_initiale(story: "Story") -> bool:
    text = "".join(b.text for b in story.blocks).strip()
    return (
        0 < len(text) <= INITIALE_HOECHSTLAENGE
        and text[0].isalpha()
        and text[0].isupper()
    )


def _abstand(a: SourceBlock, b: SourceBlock) -> float:
    ka = a.frame_box or (a.x0, a.y0, a.x1, a.y1)
    kb = b.frame_box or (b.x0, b.y0, b.x1, b.y1)
    return abs(ka[0] - kb[0]) + abs(ka[1] - kb[1])


# Die Initiale steht im Textrahmen ihres Absatzes (der Text laeuft um sie
# herum) oder knapp davor. Ohne Rahmenangabe zaehlt der Abstand der Ecken.
INITIALE_RAND = 0.02
INITIALE_ABSTAND = 0.05


def _initiale_passt(initiale: SourceBlock, absatz: SourceBlock) -> bool:
    if initiale.page_index != absatz.page_index:
        return False
    i = initiale.frame_box or (initiale.x0, initiale.y0, initiale.x1, initiale.y1)
    if absatz.frame_box is None:
        return _abstand(initiale, absatz) <= INITIALE_ABSTAND
    x0, y0, x1, y1 = absatz.frame_box
    mx, my = (i[0] + i[2]) / 2, (i[1] + i[3]) / 2
    return (
        x0 - INITIALE_RAND <= mx <= x1 + INITIALE_RAND
        and y0 - INITIALE_RAND <= my <= y1 + INITIALE_RAND
    )


def initialen_einsetzen(stories: list["Story"]) -> list["Story"]:
    """Den ausgelagerten Anfangsbuchstaben an seinen Absatz zurueckgeben.

    Der Setzer legt die Initiale gern in einen eigenen Rahmen, damit sie frei
    ueber mehrere Zeilen stehen kann. Im Satz fehlt sie dem Absatz dann am
    Anfang: "ridolin Rudolf ..." statt "Fridolin Rudolf ...". Ein Absatz, der
    klein beginnt, bekommt den Buchstaben, der in seinem Textrahmen steht;
    stehen mehrere zur Wahl (drei Buchbesprechungen auf einer Seite), gehen
    die naechstgelegenen Paare zuerst zusammen. Ein Absatz ohne Initiale in
    seinem Rahmen bleibt, wie er ist — das Editorial von ZUERST! beginnt nach
    der Anrede bewusst klein ("nicht selten sind …").
    """
    from dataclasses import replace

    initialen = [s for s in stories if _ist_initiale(s)]
    if not initialen:
        return stories
    offen = [
        s
        for s in stories
        if s.blocks
        and not _ist_initiale(s)
        and s.blocks[0].text.lstrip()[:1].islower()
    ]
    paare = sorted(
        (
            (_abstand(i.blocks[0], s.blocks[0]), n, m)
            for n, i in enumerate(initialen)
            for m, s in enumerate(offen)
            if i.blocks and _initiale_passt(i.blocks[0], s.blocks[0])
        ),
        key=lambda p: p[0],
    )
    vergeben: set[str] = set()
    versorgt: set[int] = set()
    for _abst, n, m in paare:
        initiale, story = initialen[n], offen[m]
        if initiale.story_id in vergeben or m in versorgt:
            continue
        vergeben.add(initiale.story_id)
        versorgt.add(m)
        erster = story.blocks[0]
        buchstabe = "".join(b.text for b in initiale.blocks).strip()
        story.blocks[0] = replace(erster, text=f"{buchstabe}{erster.text}")
    return [s for s in stories if s.story_id not in vergeben]


def initialen_zurueck(blocks: list[SourceBlock]) -> list[SourceBlock]:
    """`initialen_einsetzen` auf der flachen Blockliste, in ihrer Reihenfolge.

    Muss laufen, bevor Beiwerk aussortiert wird: `mark_furniture` verwirft
    jeden Block mit hoechstens zwei Zeichen — auch die Initiale. Danach fehlte
    sie in DMZ 170 einundzwanzig Artikeln ("ie Schlacht von Waterloo").
    """
    stories = stories_bilden(blocks)
    erste = {s.story_id: s.blocks[0] for s in stories if s.blocks}
    uebrig = initialen_einsetzen(stories)
    if len(uebrig) == len(stories):
        return blocks
    weg = {s.story_id for s in stories} - {s.story_id for s in uebrig}
    ersatz = {
        id(erste[s.story_id]): s.blocks[0]
        for s in uebrig
        if s.blocks and s.blocks[0] is not erste[s.story_id]
    }
    return [
        ersatz.get(id(b), b)
        for b in blocks
        if not (b.origin == "idml" and b.story_id in weg)
    ]


def stories_bilden(blocks: list[SourceBlock]) -> list[Story]:
    """Bloecke zu Stories buendeln, Reihenfolge des Satzes bleibt erhalten."""
    out: dict[str, Story] = {}
    for b in blocks:
        if b.origin != "idml":
            continue
        kennung = b.story_id or f"frei-{b.page_index}-{round(b.y0, 3)}"
        out.setdefault(kennung, Story(kennung)).blocks.append(b)
    return list(out.values())


def _titel_kandidaten(stories: list[Story], rolle: str) -> list[Story]:
    return [s for s in stories if s.rolle() == rolle]


# Wie weit vor dem Text eine Ueberschrift stehen darf. Ein Aufmacher bringt
# die Zeile auf der linken Seite, der Text beginnt rechts daneben.
VORLAUF_SEITEN = 1
# So weit duerfen Zeile und Text seitlich auseinanderliegen und noch in
# derselben Spalte stehen (Anteil der Seitenbreite).
SPALTEN_TOLERANZ = 0.08


def _kopf_zuordnen(
    koerper: list[Story], kandidaten: list[Story]
) -> dict[str, Story]:
    """Jede Zeile gehoert zu dem Mengentext, den sie ankuendigt.

    Meist steht die Ueberschrift auf derselben Seite wie der Textanfang. Bei
    einem Aufmacher steht sie auf der linken Seite und der Text beginnt erst
    rechts. Die Hoehe auf der Seite taugt nicht als Reihenfolge: die
    Textspalte beginnt oft ein paar Millimeter ueber der Zeile, weil ihr
    Rahmen bis an den Satzspiegel reicht. Deshalb zaehlt die Seite, dann die
    Spalte, dann der Abstand.

    Die Spalte zuerst: auf einer Meldungsseite stehen vier Zeilen und vier
    Texte in zwei Spalten; die Zeile links oben und der Text rechts oben
    liegen in der Hoehe naeher beieinander als Zeile und Text derselben
    Spalte. Der Text einer Zeile beginnt in ihrer Spalte, unter ihr.

    Vergeben wird nach Guete, nicht nach der Reihenfolge der Zeilen: erst
    alle Paare auf derselben Seite und in derselben Spalte, dann der Rest.
    Frueher nahm sich jede Zeile der Reihe nach den besten freien Text; eine
    verirrte Zeile auf der Seite davor (die Kartenbeschriftung in 4/2025,
    S. 45) nahm so dem naechsten Artikel seine Einleitung weg, und jede
    folgende Einleitung rutschte einen Artikel weiter — samt Seitenbereich.
    """
    paare: list[tuple[tuple, int, int]] = []
    for n, kopf in enumerate(kandidaten):
        for m, k in enumerate(koerper):
            vorlauf = k.erste_seite - kopf.erste_seite
            if not 0 <= vorlauf <= VORLAUF_SEITEN:
                continue
            # Dieselbe Spalte: der Text beginnt (fast) buendig mit der Zeile
            # und nicht ueber ihr.
            gleiche_spalte = (
                vorlauf == 0
                and abs(k.links - kopf.links) <= SPALTEN_TOLERANZ
                and k.oben >= kopf.oben - SPALTEN_TOLERANZ
            )
            guete = (
                vorlauf,
                0 if gleiche_spalte else 1,
                abs(k.oben - kopf.oben) + abs(k.links - kopf.links),
            )
            paare.append((guete, n, m))
    paare.sort(key=lambda p: p[0])
    zuordnung: dict[str, Story] = {}
    vergeben: set[int] = set()
    for _guete, n, m in paare:
        if n in vergeben or koerper[m].story_id in zuordnung:
            continue
        vergeben.add(n)
        zuordnung[koerper[m].story_id] = kandidaten[n]
    return zuordnung


# So viele kurze Textrahmen in einem Bildrahmen machen ihn zur Karte oder
# Grafik; ihre Beschriftung ("N-VA", "Flandern", "Wallonien") ist kein
# Lesetext. Ein Aufmacherfoto traegt hoechstens Zeile und Einleitung.
GRAFIK_MINDESTRAHMEN = 3
GRAFIK_HOECHSTLAENGE = 60
# Rollen, die eine Beschriftung haben kann. Ueberschrift, Bildunterschrift
# ("Bildunterschrift weiss" steht auf dem Foto) und Autor bleiben, was sie sind.
GRAFIK_ROLLEN = ("einleitung", "unterzeile", "kasten", "mengentext", "beiwerk")


def grafikbeschriftungen(stories: list[Story], bilder: list | None) -> set[str]:
    """Stories, die als Beschriftung in einer Karte oder Grafik stehen.

    Ein Bildrahmen, in dem mindestens drei kurze Textrahmen stehen, ist eine
    Karte oder Grafik: die Wahlkarte Belgiens in ZUERST! 4/2025 traegt zwoelf
    Parteinamen und Landesteile, gesetzt im Format "Einleitungstext". Als
    Einleitung kamen sie an den naechsten Artikel. Was dagegen ein eigenes
    Format fuer Kartentext hat ("Text in der Karte"), erkennt schon
    `rolle_fuer`.
    """
    if not bilder:
        return set()
    kurz = [
        s
        for s in stories
        if s.blocks
        and len(s.seiten) == 1
        and s.zeichen <= GRAFIK_HOECHSTLAENGE
        and s.rolle() in GRAFIK_ROLLEN
    ]
    out: set[str] = set()
    for bild in bilder:
        drin = []
        for s in kurz:
            if s.erste_seite != bild.page_index:
                continue
            x0, y0, x1, y1 = s.rahmen
            mx, my = (x0 + x1) / 2, (y0 + y1) / 2
            if bild.x0 <= mx <= bild.x1 and bild.y0 <= my <= bild.y1:
                drin.append(s.story_id)
        if len(drin) >= GRAFIK_MINDESTRAHMEN:
            out.update(drin)
    return out


def _text(story: Story) -> str:
    return zeilen_verbinden(b.text for b in story.blocks)


def _erster_satz(text: str, laenge: int = 80) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= laenge:
        return text
    schnitt = text[:laenge].rsplit(" ", 1)[0]
    return f"{schnitt} …"


def ist_buchanzeige(text: str) -> bool:
    """Bietet der Text ein Buch an? Ein Preis mit Umfang oder Artikelnummer.

    Ein Preis allein reicht nicht: das Impressum nennt den Abopreis, eine
    Meldung den Auftragswert.
    """
    from .anzeige import _PREIS, _REFERENZ

    return bool(_PREIS.search(text)) and bool(
        _UMFANG.search(text) or _REFERENZ.search(text)
    )


def _ist_titelrahmen(story: Story) -> bool:
    """Kurze Zeilen ohne Absatzformat, die keine Anschrift sind."""
    from .anzeige import _KONTAKT

    return (
        story.rolle() == "beiwerk"
        and all(
            (b.style_name or "").lower() in OHNE_FORMAT
            and len(b.text) <= BEIWERK_HOECHSTLAENGE
            for b in story.blocks
        )
        and not _KONTAKT.search(_text(story))
    )


def _titelrahmen(anzeige: Story, frei: list[Story]) -> list[Story]:
    """Die Rahmen ohne Format, die fast buendig ueber der Anzeige stehen.

    Von unten nach oben: erst der Rahmen direkt ueber der Beschreibung, dann
    der ueber diesem. Zurueck kommen sie in Lesereihenfolge.
    """
    gefunden: list[Story] = []
    x0, oben, x1, _ = anzeige.rahmen
    while len(gefunden) < TITELRAHMEN_HOECHSTZAHL:

        def luecke(s: Story) -> float | None:
            if s in gefunden or s.erste_seite != anzeige.erste_seite:
                return None
            sx0, _, sx1, sunten = s.rahmen
            breite = min(sx1 - sx0, x1 - x0)
            if breite <= 0 or min(sx1, x1) - max(sx0, x0) < breite / 2:
                return None
            if sx1 - sx0 > TITELRAHMEN_BREITE * (x1 - x0):
                return None
            abstand = oben - sunten
            if not -TITELRAHMEN_UEBERLAPPUNG <= abstand <= TITELRAHMEN_LUECKE:
                return None
            return abstand

        moeglich = [(luecke(s), s) for s in frei]
        moeglich = [(a, s) for a, s in moeglich if a is not None]
        if not moeglich:
            break
        naechster = min(moeglich, key=lambda m: m[0])[1]
        gefunden.append(naechster)
        oben = naechster.rahmen[1]
    return list(reversed(gefunden))


def _gruppenkopf(anzeige: Story, frei: list[Story]) -> Story | None:
    """Ein breiter Kopf fast buendig ueber der Anzeige ("Unser Kalenderprogramm")."""
    x0, oben, x1, _ = anzeige.rahmen
    for s in frei:
        if s.erste_seite != anzeige.erste_seite:
            continue
        sx0, _, sx1, sunten = s.rahmen
        if sx1 - sx0 <= TITELRAHMEN_BREITE * (x1 - x0):
            continue
        if min(sx1, x1) - max(sx0, x0) < (x1 - x0) / 2:
            continue
        if -TITELRAHMEN_UEBERLAPPUNG <= oben - sunten <= TITELRAHMEN_LUECKE:
            return s
    return None


def _gruppen_bilden(
    kurze: list[Story], frei: list[Story]
) -> tuple[list[Story], list[tuple[Story, Story]]]:
    """Kurze Anzeigen unter einem gemeinsamen Kopf werden ein Artikel.

    Das Kalenderprogramm (sechs Kalender unter "Unser Kalenderprogramm für
    2026") ist eine Anzeige mit sechs Produkten. Eine Buecherseite hat nur
    ihren Seitentitel weit oben; ihre Buecher bleiben einzeln.
    """
    je_seite: dict[int, list[Story]] = {}
    for s in kurze:
        je_seite.setdefault(s.erste_seite, []).append(s)
    out: list[Story] = []
    gruppen: list[tuple[Story, Story]] = []
    for seite, liste in je_seite.items():
        kopf = next((k for k in (_gruppenkopf(s, frei) for s in liste) if k), None)
        if kopf is None or len(liste) < 2:
            out.extend(liste)
            continue
        liste = sorted(liste, key=lambda s: (s.oben, s.links))
        gruppe = Story(liste[0].story_id, [b for s in liste for b in s.blocks])
        out.append(gruppe)
        gruppen.append((gruppe, kopf))
    return out, gruppen


# Rubriken, unter denen eine Seite mehrere kurze Meldungen sammelt. Die Seite
# ist ein Artikel, jede Meldung ein Abschnitt darin.
MELDUNGSRUBRIK = re.compile(r"^\s*(?:nachrichten|meldungen|kurzmeldungen)\b", re.I)


def _meldungsseiten(
    artikel: list[AssembledArticle],
    paare: list[tuple[Story, AssembledArticle]],
    stories: list[Story],
) -> list[AssembledArticle]:
    """Die Meldungen einer Rubrikseite zu einem Artikel zusammenlegen.

    "Nachrichten aus Deutschland" in der DMZ: vier Meldungen, jede eine eigene
    Story mit eigener Zeile. Als vier Artikel stuenden sie lose im Heft; die
    Rubrik ist der Titel, die Zeilen der Meldungen werden Zwischentitel, in
    der Reihenfolge der Seite.
    """
    rubriken: dict[int, str] = {}
    for s in stories:
        if not s.blocks or "rubrik" not in (s.blocks[0].style_name or "").lower():
            continue
        text = _text(s)
        if MELDUNGSRUBRIK.match(text) and len(s.seiten) == 1:
            rubriken.setdefault(s.erste_seite, text)
    if not rubriken:
        return artikel
    ersetzt: dict[int, AssembledArticle | None] = {}
    for seite, rubrik in rubriken.items():
        meldungen = [st for story, st in paare if story.seiten == [seite]]
        if len(meldungen) < 2:
            continue
        bloecke: list[SourceBlock] = []
        for m in meldungen:
            zeilen = []
            for b in m.blocks:
                if b.kind != "heading" or len(zeilen) == len(m.blocks) - 1:
                    break
                zeilen.append(b)
            rest = m.blocks[len(zeilen):]
            if zeilen:
                from dataclasses import replace

                bloecke.append(
                    replace(
                        zeilen[0],
                        kind="subheading",
                        text=zeilen_verbinden(z.text for z in zeilen),
                    )
                )
            else:
                bloecke.append(_als(_kopie_mit_text(m.blocks[0], m.title), "subheading"))
            bloecke.extend(rest)
        sammel = AssembledArticle(title=rubrik, blocks=bloecke)
        ersetzt[id(meldungen[0])] = sammel
        for m in meldungen[1:]:
            ersetzt[id(m)] = None
    out: list[AssembledArticle] = []
    for a in artikel:
        if id(a) not in ersetzt:
            out.append(a)
        elif ersetzt[id(a)] is not None:
            out.append(ersetzt[id(a)])
    return out


# Absatzformate der Anzeigen und Buecherseiten ("Mengentext Katalog",
# "Autorenname Katalog", "werbeseite titel", "Bücherseite Text 2023").
ANZEIGEN_FORMATE = ("katalog", "werbeseite", "anzeige", "bücherseite", "buecherseite")


def _anzeigenformat(story: Story) -> bool:
    """Ist die Story ueberwiegend in den Formaten einer Anzeige gesetzt?"""
    gesamt = sum(len(b.text) for b in story.blocks) or 1
    werbung = sum(
        len(b.text)
        for b in story.blocks
        if any(f in (b.style_name or "").lower() for f in ANZEIGEN_FORMATE)
    )
    return werbung * 2 > gesamt


def _rahmenabstand(a: Story, b: Story) -> float:
    """Luecke zwischen den Rahmen zweier Stories auf der ersten Seite von a."""
    ax0, ay0, ax1, ay1 = a.rahmen
    bx0, by0, bx1, by1 = b.rahmen
    return max(0.0, bx0 - ax1, ax0 - bx1) + max(0.0, by0 - ay1, ay0 - by1)


def _kopie_mit_text(block: SourceBlock, text: str) -> SourceBlock:
    from dataclasses import replace

    return replace(block, text=text)


@dataclass
class Anzeigenkopf:
    """Verfasser, Titel und Untertitel aus den kurzen Anfangszeilen einer Anzeige."""

    titel: str
    titelzeilen: list[SourceBlock]
    unterzeilen: list[SourceBlock]
    autorzeilen: list[SourceBlock]

    @property
    def autor(self) -> str | None:
        """Mehrere Verfasser stehen je in einer Zeile: "Alexander Marguier/" / "Ben Krischke (Hg.)"."""
        if not self.autorzeilen:
            return None
        text = ""
        for b in self.autorzeilen:
            zeile = " ".join(b.text.split())
            text = f"{text}{zeile}" if not text or text.endswith("/") else f"{text} {zeile}"
        return text


def _anzeigenkopf(story: Story) -> Anzeigenkopf | None:
    """Kopf einer Buchanzeige aus ihren kurzen Anfangszeilen.

    "Harry Lippmann" (Format Autor) / "Militärmuseen in Deutschland" /
    "Informationsgeballt …" ergibt Titel "Militärmuseen in Deutschland".
    Steht auch der Titel im Autorformat ("Bücherseite Autor 2018": "Gustav
    Sichelschmidt" / "Wie im alten Rom"), ist die erste Zeile der Verfasser
    und die zweite der Titel — frueher hiess die Anzeige nach allem
    zusammen ("Gustav Sichelschmidt Wie im alten Rom Dekadenzerscheinungen
    …"). Eine kurze Zeile in anderem Format nach dem Titel ("Norweger
    1941–1943 in der Waffen-SS" unter "Die Freiwilligen-Legion Norwegen")
    ist der Untertitel. Eine Zeile, die mit "/" endet, nennt den ersten von
    mehreren Verfassern; die naechste Zeile gehoert dazu ("Alexander
    Marguier/" / "Ben Krischke (Hg.)", auch ohne Format: "Alfred de Zayas/"
    / "Konrad Badenheuer"). Sonst laesst sich ohne Format der Verfasser
    nicht vom Titel trennen; dann zaehlen alle kurzen Zeilen zum Titel.
    """
    autorzeilen: list[SourceBlock] = []
    titelzeilen: list[SourceBlock] = []
    unterzeilen: list[SourceBlock] = []
    for b in story.blocks:
        if len(b.text) > BEIWERK_HOECHSTLAENGE:
            break
        ist_autor = rolle_fuer(b.style_name, len(b.text)) == "autor"
        weiter = bool(autorzeilen) and autorzeilen[-1].text.rstrip().endswith("/")
        if not titelzeilen and (
            weiter
            or (not autorzeilen and (ist_autor or b.text.rstrip().endswith("/")))
        ):
            autorzeilen.append(b)
        elif not titelzeilen:
            titelzeilen.append(b)
        elif (
            not unterzeilen
            and len(titelzeilen) < 3
            and (b.style_name == titelzeilen[0].style_name or _ohne_format(b, titelzeilen[0]))
        ):
            titelzeilen.append(b)
        elif len(unterzeilen) < 2:
            unterzeilen.append(b)
        else:
            break
    if not titelzeilen:
        return None
    return Anzeigenkopf(
        titel=zeilen_verbinden(b.text for b in titelzeilen),
        titelzeilen=titelzeilen,
        unterzeilen=unterzeilen,
        autorzeilen=autorzeilen,
    )


def _ohne_format(*bloecke: SourceBlock) -> bool:
    return all((b.style_name or "").lower() in OHNE_FORMAT for b in bloecke)


# Die Buchangabe am Ende einer Besprechung: "Richard Overy. Warum Krieg?
# 368 S., geb., € 28,–. Berlin: Rowohlt, 2024." Der Umfang trennt Verfasser
# und Titel von Ausstattung und Verlag.
_BUCH_UMFANG = re.compile(r"\s\d{1,4}(?:\.\d{3})?\s*(?:S\.|Seiten)\s*,")
# Ein Punkt, der ein Kuerzel beendet, trennt nicht Verfasser und Titel
# ("Claus-M. Wolfschlag", "Dr. Stefan Scheil").
_KUERZEL = re.compile(r"(?:^|[-(])[A-ZÄÖÜ]$|^(?:Dr|Prof|St|Hrsg|Hg|jr|Jr|v)$")


def buchtitel_aus_angabe(text: str) -> str | None:
    """"Verfasser: Titel" aus einer Buchangabe, ohne Untertitel.

    "Linus Ammer. Indogermanen: Herkunft, Eigenschaften … 192 S., geb." wird
    "Linus Ammer: Indogermanen", "Cora Stephan (Hrsg.). Deutsche Legenden:
    Wer …" wird "Cora Stephan (Hrsg.): Deutsche Legenden".
    """
    t = " ".join(text.split())
    if len(t) > 400:
        return None
    umfang = _BUCH_UMFANG.search(t)
    if not umfang:
        return None
    kopf = t[: umfang.start()].rstrip().rstrip(".")
    for punkt in re.finditer(r"\.\s+(?=[„\"»A-ZÄÖÜ0-9])", kopf):
        davor = kopf[: punkt.start()].strip()
        letztes = davor.split()[-1] if davor.split() else ""
        if _KUERZEL.search(letztes):
            continue
        verfasser, titel = davor, kopf[punkt.end() :].strip()
        break
    else:
        return None
    if (
        not 3 <= len(verfasser) <= 80
        or re.search(r"\d", verfasser)
        or not verfasser[0].isupper()
        or not titel
    ):
        return None
    titel = titel.split(": ")[0].strip()
    return f"{verfasser}: {titel}"


def _besprochenes_buch(story: Story) -> str | None:
    """Titel einer Buchbesprechung aus der Buchangabe an ihrem Ende.

    Die Besprechung hat im Satz keine Ueberschrift; als Titel stand ihr
    erster Satz ("Endzeit in Schlesien. Im Dorf Rosenthal …"), die erste
    der Seite hiess nach der Kopfzeile "Buchbesprechungen". Gesucht wird in
    den letzten beiden Absaetzen, hinter wenigstens einem Absatz Text.
    """
    if len(story.blocks) < 2:
        return None
    for b in story.blocks[-2:]:
        titel = buchtitel_aus_angabe(b.text)
        if titel and b is not story.blocks[0]:
            return titel
    return None


# Ein Titel in eigenem Rahmen ohne Format mitten im Textrahmen: die Kolumne
# von ZUERST! ("Unseriöse Medien" unter dem Foto, der Text laeuft darum).
TITELRAHMEN_IM_TEXT_ZEICHEN = (8, 80)


def _titel_im_textrahmen(story: Story, frei: list[Story]) -> Story | None:
    """Ein kurzer Rahmen ohne Format, der ganz im Textrahmen der Story steht."""
    x0, y0, x1, y1 = story.rahmen
    rand = 0.005
    moeglich = []
    for s in frei:
        if s.erste_seite != story.erste_seite or len(s.seiten) != 1 or len(s.blocks) > 3:
            continue
        text = _text(s)
        if not (
            TITELRAHMEN_IM_TEXT_ZEICHEN[0] <= len(text) <= TITELRAHMEN_IM_TEXT_ZEICHEN[1]
            and text[:1].isupper()
            and re.search(r"[^\W\d_]{4}", text)
        ):
            continue
        sx0, sy0, sx1, sy1 = s.rahmen
        if sx0 >= x0 - rand and sy0 >= y0 - rand and sx1 <= x1 + rand and sy1 <= y1 + rand:
            moeglich.append(s)
    return min(moeglich, key=lambda s: (s.oben, s.links)) if moeglich else None


# So viele Zeilen hat eine Ueberschrift, die der Setzer mit Absatzmarken
# umbrochen hat ("Wadephul warnt vor" / "Debatte über NATO-Zerfall").
ZEILEN_HOECHSTZAHL = 4


def _eigene_zeilen(blocks: list[SourceBlock]) -> list[SourceBlock]:
    """Die Zeilen am Anfang einer Story, die ihre Ueberschrift bilden.

    Alle aufeinanderfolgenden Absaetze im Ueberschriftformat zaehlen, nicht
    nur der erste: frueher hiessen Meldungen "Wadephul warnt vor", "Erich
    Raeder" (mit "vergrößert" und "die Kriegsmarine" als Zwischentiteln im
    Text). Eine Anrede ("Sehr geehrte Leser,") im Ueberschriftformat ist
    keine Zeile, sondern der erste Satz des Editorials.
    """
    from .rubriken import ANREDE

    zeilen: list[SourceBlock] = []
    for b in blocks[:ZEILEN_HOECHSTZAHL]:
        rolle = rolle_fuer(b.style_name, len(b.text))
        if rolle not in ("ueberschrift", "zwischentitel") or len(b.text) > 120:
            break
        if not zeilen and ANREDE.match(b.text):
            break
        zeilen.append(b)
    return zeilen


def _meldungen_trennen(stories: list[Story]) -> tuple[list[Story], set[str]]:
    """Eine Story mit mehreren Meldungen wird je Meldung eine Story.

    ZUERST! 3/2026, S. 25: "Wadephul warnt vor Debatte über NATO-Zerfall"
    und "Bundeswehr-General verlangt Atombombe" stehen in einem Textrahmen,
    jede mit eigener Zeile im Ueberschriftformat. Als ein Artikel hiess das
    Ganze nach der ersten Zeile, die zweite Meldung lief als Zwischentitel
    mit. Getrennt wird nur, wenn die Story mit einer Zeile beginnt und jede
    Zeile Text nach sich hat; die Teile sind Artikel, auch wenn sie kurz sind.
    """
    out: list[Story] = []
    geteilt: set[str] = set()
    for story in stories:
        rollen = [rolle_fuer(b.style_name, len(b.text)) for b in story.blocks]
        anfaenge = [
            i
            for i, r in enumerate(rollen)
            if r == "ueberschrift" and (i == 0 or rollen[i - 1] != "ueberschrift")
        ]
        if (
            story.rolle() != "mengentext"
            or len(anfaenge) < 2
            or anfaenge[0] != 0
            or any(
                all(r == "ueberschrift" for r in rollen[a:e])
                for a, e in zip(anfaenge, anfaenge[1:] + [len(rollen)])
            )
        ):
            out.append(story)
            continue
        for n, (a, e) in enumerate(zip(anfaenge, anfaenge[1:] + [len(rollen)])):
            teil = Story(story.story_id if n == 0 else f"{story.story_id}#{n}", story.blocks[a:e])
            out.append(teil)
            geteilt.add(teil.story_id)
    return out, geteilt


def _anrede_zusammenziehen(story: Story) -> None:
    """"Verehrter" / "Leser," in zwei Absaetzen (DMZ-Editorial) wird ein Absatz."""
    from dataclasses import replace

    from .rubriken import ANREDE

    for n in (2, 3):
        anfang = story.blocks[:n]
        if len(anfang) < n or any(len(b.text) > 25 for b in anfang):
            continue
        text = " ".join(b.text.strip() for b in anfang)
        if ANREDE.match(text) and text.endswith(","):
            story.blocks[:n] = [replace(anfang[0], text=text)]
            return


def artikel_aus_satz(
    blocks: list[SourceBlock], images: list | None = None
) -> list[AssembledArticle]:
    """Artikel aus den Stories des Satzes.

    Jede Mengentext-Story wird ein Artikel. Ueberschrift, Unterzeile und Autor
    kommen aus den Stories, die auf derselben Seite darueber beginnen; Kaesten
    und Bildunterschriften aus den Seiten, die der Artikel belegt.

    Schmuckzitate und Seitenrubriken bleiben draussen. Auf der Druckseite
    helfen sie beim Blaettern; im Fliesstext stuenden sie als loser Halbsatz
    zwischen zwei Absaetzen ("Russische Panzerkorps" / "schwer angeschlagen").
    Ein Zitat, das der Autor in den Mengentext gesetzt hat, gehoert zu dessen
    Story und bleibt stehen.
    """
    stories = initialen_einsetzen(stories_bilden(blocks))
    # Beschriftungen in Karten und Grafiken gehoeren zur Zeichnung.
    grafik = grafikbeschriftungen(stories, images)
    stories = [s for s in stories if s.story_id not in grafik]
    for s in stories:
        _anrede_zusammenziehen(s)
    stories, geteilt = _meldungen_trennen(stories)
    lang = [
        s
        for s in stories
        if s.rolle() == "mengentext"
        and (s.textzeichen >= ARTIKEL_MINDESTZEICHEN or s.story_id in geteilt)
    ]
    # Kurze Buchanzeigen tragen Verfasser und Titel selbst; eine Ueberschrift
    # der Seite ("ALT!" als Blickfang) bekommen sie nicht.
    kurze_anzeigen = [
        s
        for s in stories
        if s.rolle() == "mengentext"
        and ANZEIGE_MINDESTZEICHEN <= s.textzeichen < ARTIKEL_MINDESTZEICHEN
        and ist_buchanzeige(_text(s))
    ]
    frei = [s for s in stories if _ist_titelrahmen(s)]
    titelrahmen: dict[str, list[Story]] = {}
    als_anzeige = {s.story_id for s in kurze_anzeigen}
    kurze_anzeigen, gruppen = _gruppen_bilden(kurze_anzeigen, frei)
    for gruppe, kopf in gruppen:
        titelrahmen[gruppe.story_id] = [kopf]
        frei = [s for s in frei if s is not kopf]
    koerper = sorted(lang + kurze_anzeigen, key=lambda s: (s.erste_seite, s.oben, s.links))
    anzeigen = {s.story_id for s in koerper if ist_buchanzeige(_text(s))}
    for story in koerper:
        if story.story_id not in anzeigen or story.story_id in titelrahmen:
            continue
        gefunden = _titelrahmen(story, frei)
        if gefunden:
            titelrahmen[story.story_id] = gefunden
            frei = [s for s in frei if s not in gefunden]

    ueberschriften = _titel_kandidaten(stories, "ueberschrift")
    unterzeilen = _titel_kandidaten(stories, "unterzeile")
    einleitungen = _titel_kandidaten(stories, "einleitung")
    autoren = _titel_kandidaten(stories, "autor")
    kaesten = _titel_kandidaten(stories, "kasten")
    kurze = [
        s
        for s in stories
        if s.rolle() == "mengentext"
        and s.textzeichen < ARTIKEL_MINDESTZEICHEN
        and s.story_id not in als_anzeige
        and s.story_id not in geteilt
    ]

    kopf_zu = _kopf_zuordnen(lang, ueberschriften)
    unter_zu = _kopf_zuordnen(lang, unterzeilen)
    einleitung_zu = _kopf_zuordnen(lang, einleitungen)

    vergeben: set[str] = set()
    artikel: list[AssembledArticle] = []
    paare: list[tuple[Story, AssembledArticle]] = []
    belegte_seiten: dict[int, AssembledArticle] = {}

    for story in koerper:
        kopf = kopf_zu.get(story.story_id)
        unter = unter_zu.get(story.story_id)
        einleitung = einleitung_zu.get(story.story_id)

        eigene: list[SourceBlock] = []
        if kopf:
            for b in kopf.blocks:
                eigene.append(_als(b, "heading"))
        # Unterzeile und Vorspann sind je ein Absatz; der Setzer bricht ihre
        # Zeilen mit Absatzmarken ("… wo er Anfang 1944 als" / "ausgebildet").
        for vorn in (unter, einleitung):
            if vorn:
                eigene.append(_als(_kopie_mit_text(vorn.blocks[0], _text(vorn)), "lead"))
        eigene.extend(story.blocks)
        rahmen = [] if kopf else titelrahmen.get(story.story_id, [])
        eigene[0:0] = [_als(b, "heading") for r in rahmen for b in r.blocks]

        aus_text = False
        anzeigen_unterzeile: str | None = None
        anzeigenkopf = _anzeigenkopf(story) if story.story_id in anzeigen else None
        if kopf:
            titel = _text(kopf)
        elif any(story is g for g, _ in gruppen):
            titel = _text(rahmen[-1])
        elif anzeigenkopf:
            # Verfasser und Titel in der Anzeige selbst; ein Rahmen darueber
            # ist dann ein Werbesatz ("Legionäre für Europa"). Im Lesetext
            # stuenden Verfasser, Titel und Untertitel sonst ein zweites Mal.
            titel = anzeigenkopf.titel
            for b in anzeigenkopf.titelzeilen:
                eigene[eigene.index(b)] = _als(b, "heading")
            if anzeigenkopf.unterzeilen:
                anzeigen_unterzeile = zeilen_verbinden(b.text for b in anzeigenkopf.unterzeilen)
                for b in anzeigenkopf.unterzeilen:
                    eigene[eigene.index(b)] = _als(b, "lead")
            for b in anzeigenkopf.autorzeilen:
                eigene.remove(b)
        elif rahmen:
            # Sonst nennt der Rahmen direkt ueber der Beschreibung Verfasser
            # und Titel, darueber steht der Werbesatz.
            titel = _text(rahmen[-1])
        else:
            # Kurze Meldungen tragen ihre Zeile als ersten Absatz der eigenen
            # Story ("Philipp Wild geboren" im Kalenderblatt). Dann ist das
            # Format des ersten Absatzes die Ueberschrift, nicht das der Story.
            zeilen = _eigene_zeilen(story.blocks)
            erster = story.blocks[0]
            buch = None if zeilen else _besprochenes_buch(story)
            im_rahmen = None if zeilen or buch else _titel_im_textrahmen(story, frei)
            if zeilen:
                titel = zeilen_verbinden(b.text for b in zeilen)
                for b in zeilen:
                    eigene[eigene.index(b)] = _als(b, "heading")
            elif buch:
                # Buchbesprechung: "Verfasser: Titel" aus der Buchangabe.
                titel = buch
            elif im_rahmen is not None:
                titel = _text(im_rahmen)
                frei = [s for s in frei if s is not im_rahmen]
                eigene[0:0] = [_als(b, "heading") for b in im_rahmen.blocks]
            else:
                aus_text = True
                titel = _erster_satz(_text(story))
            if erster.kind == "heading" and erster not in zeilen and erster in eigene:
                # Die Anrede im Ueberschriftformat bleibt erster Absatz.
                eigene[eigene.index(erster)] = _als(erster, "paragraph")
        # Der Autor im eigenen Text zuerst: ZUERST! und DMZ setzen ihn als
        # Absatz im Format "Autorenname" ans Ende des Mengentexts. Eine
        # Autorzeile in einem eigenen Rahmen zaehlt erst danach, und nie
        # die einer Anzeige: in 3/2026 trug die Titelgeschichte sonst die
        # Schlagzeile der Buchanzeige auf S. 15 ("Was die Deutschen nicht
        # wissen sollen") als Autor.
        autor = (anzeigenkopf.autor if anzeigenkopf and not kopf else None) or next(
            (
                b.text
                for b in story.blocks
                if rolle_fuer(b.style_name, len(b.text)) == "autor"
            ),
            None,
        )
        if autor is None:
            for a in autoren:
                if a.story_id in vergeben or _anzeigenformat(a):
                    continue
                if a.erste_seite in story.seiten:
                    autor = _text(a)
                    vergeben.add(a.story_id)
                    break

        unterzeile, vorspann = _unterzeile_und_vorspann(unter, einleitung)
        unterzeile = unterzeile or anzeigen_unterzeile
        stueck = AssembledArticle(
            title=titel,
            blocks=eigene,
            subtitle=unterzeile,
            author=autor,
            teaser=vorspann,
            title_from_body=not kopf and aus_text,
        )
        artikel.append(stueck)
        paare.append((story, stueck))

    artikel = _meldungsseiten(artikel, paare, stories)
    noch_da = {id(a) for a in artikel}
    for story, stueck in paare:
        if id(stueck) in noch_da:
            for seite in story.seiten:
                belegte_seiten.setdefault(seite, stueck)
    for stueck in artikel:
        # Zusammengelegte Meldungsseite.
        for seite in stueck.pages:
            belegte_seiten.setdefault(seite, stueck)

    # Teile einer Anzeige (der Preis "€ 32,80" in eigenem Rahmen, die
    # Schlagzeile im Format "Autorenname Katalog") gehoeren zur Anzeige
    # derselben Seite, nie in den redaktionellen Artikel daneben.
    anzeigen_auf_seite = [
        (s, st)
        for s, st in paare
        if id(st) in noch_da and (_anzeigenformat(s) or s.story_id in anzeigen)
    ]

    def anzeige_zu(teil: Story) -> AssembledArticle | None:
        moeglich = [
            (_rahmenabstand(teil, s), n, st)
            for n, (s, st) in enumerate(anzeigen_auf_seite)
            if teil.erste_seite in s.seiten
        ]
        return min(moeglich, key=lambda m: m[:2])[2] if moeglich else None

    for kopf in autoren:
        if kopf.story_id in vergeben or not _anzeigenformat(kopf):
            continue
        ziel = anzeige_zu(kopf)
        if ziel is None:
            continue
        zeile = _text(kopf)
        ziel.blocks.insert(0, _als(_kopie_mit_text(kopf.blocks[0], zeile), "heading"))
        if ziel.title_from_body:
            ziel.title = zeile
            ziel.title_from_body = False

    # Kaesten und kurze Reste wandern in den Artikel ihrer Seite — und dort
    # hinter den letzten Absatz derselben Seite, damit sie im Lesefluss an der
    # richtigen Stelle stehen und nicht am Ende des Artikels.
    for rest in kaesten + kurze:
        if _anzeigenformat(rest) and rest.textzeichen < ANZEIGE_MINDESTZEICHEN:
            ziel = anzeige_zu(rest)
            if ziel is not None:
                ziel.blocks.extend(_als(b, "paragraph") for b in rest.blocks)
            continue
        ziel = belegte_seiten.get(rest.erste_seite)
        if ziel is None and any(b.kind == "table" for b in rest.blocks):
            # Eine Tabelle steht oft allein auf der Nachbarseite ihres Textes,
            # etwa rechts auf der Doppelseite neben dem Beitrag. Ohne diesen
            # Schritt ginge sie verloren oder wuerde ein eigener "Artikel".
            ziel = belegte_seiten.get(rest.erste_seite - 1) or belegte_seiten.get(
                rest.erste_seite + 1
            )
        if ziel is None:
            continue
        art = "box" if rest.rolle() == "kasten" else "paragraph"
        # Eine Tabelle bleibt eine Tabelle, auch in einem Kasten.
        neue = [b if b.kind == "table" else _als(b, art) for b in rest.blocks]
        stelle = _letzte_stelle(ziel.blocks, rest.erste_seite)
        ziel.blocks[stelle:stelle] = neue

    if images:
        # Die Zuordnung der Bilder ist dieselbe wie beim PDF-Weg: Spalte,
        # Textmenge auf der Seite, sonst der Artikel, der die Seite traegt.
        from .article_assembler import _attach_images

        _attach_images(artikel, images)
    return artikel


# Eine Unterzeile hat zwei, drei Zeilen (ZUERST!: 40 bis 140 Zeichen). Ein
# Vorspann von fuenf Saetzen (DMZ-Soldatenportraet, 550 bis 600 Zeichen) ist
# Lesetext und gehoert als Vorspann-Absatz in den Artikel, nicht in den Kopf.
UNTERZEILE_HOECHSTLAENGE = 250


def _unterzeile_und_vorspann(
    unter: Story | None, einleitung: Story | None
) -> tuple[str | None, str | None]:
    """Unterzeile und Vorspann des Kopfes.

    Die Unterzeile ist die kurze Zeile unter dem Titel — bei der DMZ im
    Format "Unterueberschrift", bei ZUERST! im "Einleitungstext" (eine eigene
    Unterzeile gibt es dort nicht). Der Leser zeigt nur die Unterzeile im
    Kopf; was als Vorspann (`teaser`) im Kopf stand, fehlte im Lesetext, weil
    der gleichlautende Absatz als Wiederholung des Kopfes wegfiel. Deshalb:

    * kurze Unterzeile oder, ohne sie, kurze Einleitung: Unterzeile;
    * eine Einleitung, die zur Unterzeile wurde, steht auch als Vorspann
      (fuer die Suche) — im Lesetext faellt sie als Wiederholung weg;
    * alles Lange und eine zweite Einleitung neben der Unterzeile bleiben
      Vorspann-Absaetze im Text.
    """
    unter_text = _text(unter) if unter else None
    einleitung_text = _text(einleitung) if einleitung else None

    def kurz(t: str | None) -> bool:
        return bool(t) and len(t) <= UNTERZEILE_HOECHSTLAENGE

    if kurz(unter_text):
        return unter_text, None
    if kurz(einleitung_text):
        return einleitung_text, einleitung_text
    return None, None


def _letzte_stelle(blocks: list[SourceBlock], seite: int) -> int:
    """Hinter den letzten Absatz dieser Seite; sonst ans Ende.

    Beginnt der Artikel erst nach dieser Seite, steht das Stueck vor seinem
    Text, aber hinter Ueberschrift und Vorspann.
    """
    if blocks and all(b.page_index > seite for b in blocks):
        return next(
            (i for i, b in enumerate(blocks) if b.kind not in ("heading", "lead")),
            len(blocks),
        )
    stelle = len(blocks)
    for i, b in enumerate(blocks):
        if b.page_index <= seite:
            stelle = i + 1
    return stelle


def _als(block: SourceBlock, kind: str) -> SourceBlock:
    """Denselben Block mit anderer Rolle — die Lage bleibt unberuehrt."""
    if block.kind == kind:
        return block
    from dataclasses import replace

    return replace(block, kind=kind)
