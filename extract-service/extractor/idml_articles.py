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


def initialen_einsetzen(stories: list["Story"]) -> list["Story"]:
    """Den ausgelagerten Anfangsbuchstaben an seinen Absatz zurueckgeben.

    Der Setzer legt die Initiale gern in einen eigenen Rahmen, damit sie frei
    ueber mehrere Zeilen stehen kann. Im Satz fehlt sie dem Absatz dann am
    Anfang: "ridolin Rudolf ..." statt "Fridolin Rudolf ...". Gesucht wird der
    naechstgelegene freie Buchstabe auf derselben Seite.
    """
    from dataclasses import replace

    initialen = [s for s in stories if _ist_initiale(s)]
    if not initialen:
        return stories
    vergeben: set[str] = set()
    for story in stories:
        if not story.blocks or _ist_initiale(story):
            continue
        erster = story.blocks[0]
        text = erster.text.lstrip()
        if not text or not text[0].islower():
            continue
        moeglich = [
            i
            for i in initialen
            if i.story_id not in vergeben
            and i.blocks
            and i.blocks[0].page_index == erster.page_index
        ]
        if not moeglich:
            continue
        treffer = min(moeglich, key=lambda i: _abstand(i.blocks[0], erster))
        vergeben.add(treffer.story_id)
        buchstabe = "".join(b.text for b in treffer.blocks).strip()
        story.blocks[0] = replace(erster, text=f"{buchstabe}{erster.text}")
    return [s for s in stories if s.story_id not in vergeben]


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
    """
    zuordnung: dict[str, Story] = {}
    for kopf in sorted(kandidaten, key=lambda s: (s.erste_seite, s.oben, s.links)):
        moeglich = [
            k
            for k in koerper
            if k.story_id not in zuordnung
            and 0 <= k.erste_seite - kopf.erste_seite <= VORLAUF_SEITEN
        ]
        if not moeglich:
            continue

        def passt(k: Story) -> tuple:
            gleiche_seite = k.erste_seite == kopf.erste_seite
            # Dieselbe Spalte: der Text beginnt (fast) buendig mit der Zeile
            # und nicht ueber ihr.
            gleiche_spalte = (
                gleiche_seite
                and abs(k.links - kopf.links) <= SPALTEN_TOLERANZ
                and k.oben >= kopf.oben - SPALTEN_TOLERANZ
            )
            return (
                k.erste_seite - kopf.erste_seite,
                0 if gleiche_spalte else 1,
                abs(k.oben - kopf.oben) + abs(k.links - kopf.links),
            )

        ziel = min(moeglich, key=passt)
        zuordnung[ziel.story_id] = kopf
    return zuordnung


def _text(story: Story) -> str:
    return " ".join(b.text for b in story.blocks).strip()


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


def _anzeigenzeilen(story: Story) -> str:
    """Titel einer Anzeige aus ihren kurzen Anfangszeilen, ohne den Verfasser.

    "Harry Lippmann" / "Militärmuseen in Deutschland" / "Informationsgeballt
    …" ergibt "Militärmuseen in Deutschland". Ohne Format laesst sich der
    Verfasser nicht vom Titel trennen; dann zaehlen alle kurzen Zeilen.
    """
    zeilen: list[str] = []
    for b in story.blocks:
        if len(b.text) > BEIWERK_HOECHSTLAENGE or len(zeilen) >= 3:
            break
        if rolle_fuer(b.style_name, len(b.text)) == "autor":
            continue
        zeilen.append(b.text.strip())
    return " ".join(z for z in zeilen if z)


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
    lang = [
        s
        for s in stories
        if s.rolle() == "mengentext" and s.textzeichen >= ARTIKEL_MINDESTZEICHEN
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
    koerper = sorted(lang + kurze_anzeigen, key=lambda s: (s.erste_seite, s.oben, s.links))
    anzeigen = {s.story_id for s in koerper if ist_buchanzeige(_text(s))}
    frei = [s for s in stories if _ist_titelrahmen(s)]
    titelrahmen: dict[str, list[Story]] = {}
    for story in koerper:
        if story.story_id not in anzeigen:
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
        and s not in kurze_anzeigen
    ]

    kopf_zu = _kopf_zuordnen(lang, ueberschriften)
    unter_zu = _kopf_zuordnen(lang, unterzeilen)
    einleitung_zu = _kopf_zuordnen(lang, einleitungen)

    vergeben: set[str] = set()
    artikel: list[AssembledArticle] = []
    belegte_seiten: dict[int, AssembledArticle] = {}

    for story in koerper:
        kopf = kopf_zu.get(story.story_id)
        unter = unter_zu.get(story.story_id)
        einleitung = einleitung_zu.get(story.story_id)

        eigene: list[SourceBlock] = []
        if kopf:
            for b in kopf.blocks:
                eigene.append(_als(b, "heading"))
        if unter:
            for b in unter.blocks:
                eigene.append(_als(b, "lead"))
        if einleitung:
            for b in einleitung.blocks:
                eigene.append(_als(b, "lead"))
        eigene.extend(story.blocks)
        rahmen = [] if kopf else titelrahmen.get(story.story_id, [])
        eigene[0:0] = [_als(b, "heading") for r in rahmen for b in r.blocks]

        aus_text = False
        if kopf:
            titel = _text(kopf)
        elif story.story_id in anzeigen and _anzeigenzeilen(story):
            # Verfasser und Titel in der Anzeige selbst; ein Rahmen darueber
            # ist dann ein Werbesatz ("Legionäre für Europa").
            titel = _anzeigenzeilen(story)
        elif rahmen:
            # Sonst nennt der Rahmen direkt ueber der Beschreibung Verfasser
            # und Titel, darueber steht der Werbesatz.
            titel = _text(rahmen[-1])
        else:
            # Kurze Meldungen tragen ihre Zeile als ersten Absatz der eigenen
            # Story ("Philipp Wild geboren" im Kalenderblatt). Dann ist das
            # Format des ersten Absatzes die Ueberschrift, nicht das der Story.
            erster = story.blocks[0]
            eigene_zeile = (
                rolle_fuer(erster.style_name, len(erster.text))
                in ("ueberschrift", "zwischentitel")
                and len(erster.text) <= 120
            )
            aus_text = not eigene_zeile
            if eigene_zeile:
                titel = erster.text
                eigene[eigene.index(erster)] = _als(erster, "heading")
            else:
                titel = _erster_satz(_text(story))
        autor = None
        for a in autoren:
            if a.story_id in vergeben:
                continue
            if a.erste_seite in story.seiten:
                autor = _text(a)
                vergeben.add(a.story_id)
                break
        # Ein Autorenname kann auch als letzter Absatz im Mengentext stehen.
        if autor is None:
            for b in story.blocks:
                if rolle_fuer(b.style_name, len(b.text)) == "autor":
                    autor = b.text
                    break

        stueck = AssembledArticle(
            title=titel,
            blocks=eigene,
            subtitle=_text(unter) if unter else None,
            author=autor,
            teaser=_text(einleitung) if einleitung else None,
            title_from_body=not kopf and aus_text,
        )
        artikel.append(stueck)
        for seite in story.seiten:
            belegte_seiten.setdefault(seite, stueck)

    # Kaesten und kurze Reste wandern in den Artikel ihrer Seite — und dort
    # hinter den letzten Absatz derselben Seite, damit sie im Lesefluss an der
    # richtigen Stelle stehen und nicht am Ende des Artikels.
    for rest in kaesten + kurze:
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
