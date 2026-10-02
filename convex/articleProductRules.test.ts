import { describe, expect, test } from "vitest";
import {
  RuleProduct,
  TitleHint,
  blockKey,
  findHints,
  isShopUrl,
  pickByReference,
  pickByTitle,
  scoreByTitle,
  searchQuery,
} from "./articleProductRules";

// Die Texte stammen aus den Heften, wie sie am 30.09.2026 live standen; die
// Produkte sind die Antworten des Ladens auf die Suchanfragen.

const article = (title: string, texts: string[]) => ({
  title,
  blocks: texts.map((text, i) => ({ order: i + 1, text })),
});

const product = (
  id: number,
  name: string,
  reference: string,
  priceCents: number | null,
  manufacturer = "",
): RuleProduct => ({ id, name, reference, priceCents, manufacturer });

const titleHint = (a: ReturnType<typeof article>): TitleHint => {
  const hint = findHints(a).find((h) => h.kind === "title");
  if (!hint || hint.kind !== "title") throw new Error("kein Titelhinweis");
  return hint;
};

const GENERALE = article("Nikolaus v. Preradovich Die Generale der Waffen‑SS", [
  "Nikolaus v. Preradovich",
  "Die Generale der Waffen‑SS",
  "Vom SS‑Brigadeführer und Generalmajor der Waffen‑SS bis zum SS‑Oberst-Gruppenführer reichten die Generalsränge. Rund 100 dieser Männer stellt das vorliegende Nachschlagewerk in Einzelbiographien vor. 304 S., viele s/w. Porträtfotos, geb. im Großformat.",
  "Art. 101208 t 29,80",
]);

const EICHENLAUB = article("Fritjof Schaulen Eichenlaubträger 1940–1945", [
  "Fritjof Schaulen",
  "Eichenlaubträger 1940–1945",
  "Das Ritterkreuz mit Eichenlaub wurde an insgesamt 882 Soldaten verliehen. Von über 350 von ihnen gibt es hochwertige Farb-",
  "fotographien, die hier erstmals präsentiert werden. Je 160 S., durchgängig farbig, geb. im Atlas-Großformat. je t 27,95",
  "Band I Art. 102201 Abraham–Huppertz",
  "Band II Art. 102214 Ihlefeld–Primozic",
  "Band III Art. 102227 Radusch–Zwernemann",
  "Gesamtwerk (alle drei Bände)",
  "Art. 102230 nur t 69,90",
  "Sie sparen t 13,95!",
]);

const THESEN = article("Alfred de Zayas/ Konrad Badenheuer 80 Thesen zur Vertreibung Aufarbeiten statt …", [
  "Alfred de Zayas/",
  "Konrad Badenheuer",
  "80 Thesen zur Vertreibung",
  "Aufarbeiten statt verdrängen. – Die Vertreibung von 14 Millionen Ostdeutschen nach 1945 ist eine Zäsur der deutschen Geschichte und hat die Landkarte Europas verändert. Außerdem erwähnt die Neuauflage aktuelle politische Entwicklungen, darunter die polnische Reparationsforderung von 1,3 Billionen Euro. 216 S., s/w. Abb., Pb., € 17,90.",
]);

const OVERY = article("eltgeschichte ist Kriegsgeschichte.", [
  "eltgeschichte ist Kriegsgeschichte. Trotzdem seien Historiker „kaum beteiligt, wenn es um Antworten auf die Frage geht, warum die Menschen Kriege führen“, so Richard Overy. „Die Aussicht auf eine Welt ohne Krieg erscheint verschwindend gering.“ E.G.",
  "Richard Overy. Warum Krieg? 368 S., geb., t 28,–. Berlin: Rowohlt Berlin Verlag, 2024.",
]);

const WISNEWSKI = article("Dauerberieselung 24/7", [
  "Dauerberieselung 24/7, ununterbrochener Nachrichtenstrom, digitale Reizüberflutung – die Sachen gehen in den Kopf hinein und wieder hinaus; man weiß es. In einem längeren Schlußteil beleuchtet er „den wahren ‚Great Reset‘“. A.L.",
  "Gerhard Wisnewski. Verheimlicht, vertuscht, vergessen 2026 – Das andere Jahrbuch: Was 2025 nicht in der Zeitung stand. 288 S., geb., € 18,–. Rottenburg: Kopp Verlag, 2026.",
  "Buchbesprechungen",
]);

const VETERANEN = article("Im zwölften Band der Reihe", [
  "Im zwölften Band der Reihe schildern zwei weitere Waffen‑SS--Veteranen ihre Kriegserlebnisse. Zu Fuß ging Glade im Sommer 1945 zurück nach Hause nach Magdeburg. L.P.",
  "Erich Thöle/Martin Glade. Veteranen der Waffen-SS berichten. Bd. 12. 120 S., geb., t 18,80. Riesa: Nation & Wissen Verlag, 2025.",
]);

const UNBEKANNT = article("Am 16. April 1945 begann der Endkampf um Berlin.", [
  "Am 16. April 1945 begann der Endkampf um Berlin. Mit der 1. Weißrussischen Front trat die Rote Armee an der Oder zum Angriff an. Die Chronik folgt den Ereignissen Tag für Tag. L.P.",
  "Henrik Schulze. Unbekannt – April 1945: Chronik der Kriegs-ereignisse vom 16. April bis zum 8. Mai 1945 und die Geschichte des Soldatenfriedhofs Halbe. Bd. 1: 16. bis 24. April 1945. 544 S., geb., t 40,–. Jüterbog: Eigenverlag, 2025.",
]);

describe("Anzeigen erkennen", () => {
  test("Artikelnummer: die Beschreibung davor bekommt keinen zweiten Hinweis", () => {
    expect(findHints(GENERALE)).toEqual([{ kind: "number", blockOrder: 4, reference: "101208" }]);
  });

  test("mehrere Baende einer Anzeige, jede Nummer an ihrem Absatz", () => {
    expect(findHints(EICHENLAUB)).toEqual([
      { kind: "number", blockOrder: 5, reference: "102201" },
      { kind: "number", blockOrder: 6, reference: "102214" },
      { kind: "number", blockOrder: 7, reference: "102227" },
      { kind: "number", blockOrder: 9, reference: "102230" },
    ]);
  });

  test("der Titel ueber den Anzeigenzeilen zaehlt mit, auch wenn der Lesetext ihn auslaesst", () => {
    // ZUERST! S. 77: "Halbmondsüchtig" steht nur als Artikeltitel, der
    // Lesetext beginnt mit dem Verfasser.
    const [hint] = findHints(
      article("Halbmondsüchtig", [
        "Sophie Liebnitz",
        "Xenomanie in Europa. – Europas Weltoffenheit ist einzigartig. Die " +
          "fatale Folge ist eine Selbstaufgabe ohne Beispiel: Grenzen fallen, " +
          "Traditionen werden preisgegeben, und wer widerspricht, gilt als " +
          "Feind der offenen Gesellschaft. 160 S., Pb. t 20,–",
      ]),
    );
    expect(hint.kind).toBe("title");
    if (hint.kind !== "title") return;
    expect(hint.lines.slice(0, 2)).toEqual(["Sophie Liebnitz", "Halbmondsüchtig"]);
    expect(hint.queries).toContain("Halbmondsüchtig");
    expect(hint.zone).toContain("Halbmondsüchtig");
  });

  test("Schreibweisen der Artikelnummer, aber kein Gesetzesartikel", () => {
    const refs = (text: string) =>
      findHints(article("", [text])).flatMap((h) => (h.kind === "number" ? [h.reference] : []));
    expect(refs("Geb. im Atlas-Großformat. Art. 101439 t 36,80")).toEqual(["101439"]);
    expect(refs("Art.-Nr. 101439")).toEqual(["101439"]);
    expect(refs("Artikelnummer: 460705")).toEqual(["460705"]);
    expect(refs("Best.-Nr. 115924")).toEqual(["115924"]);
    expect(refs("Art. 101439 und noch einmal Art. 101439")).toEqual(["101439"]);
    expect(refs("Nach Art. 5 des Grundgesetzes und Art. 20 Abs. 4")).toEqual([]);
    expect(refs("Truppen aller Art 120000 Mann, laut Artikel 12345 der Verordnung")).toEqual([]);
    expect(refs("Der Start 101439 verlief planmäßig, die Bestände 123456 auch.")).toEqual([]);
    expect(refs("Telefon 04384 59700, Art. 1014390")).toEqual([]);
  });

  test("Anzeige ohne Nummer: Titelzeilen ueber der Beschreibung, Preis aus dem Text", () => {
    const hint = titleHint(THESEN);
    expect(hint.blockOrder).toBe(4);
    expect(hint.priceCents).toBe(1790);
    expect(hint.lines).toEqual(["Alfred de Zayas/", "Konrad Badenheuer", "80 Thesen zur Vertreibung"]);
    expect(hint.zone).toContain("Aufarbeiten statt verdrängen.");
    expect(hint.queries[0]).toBe("Alfred de Zayas Konrad Badenheuer 80 Thesen zur Vertreibung");
    expect(hint.queries).toContain("80 Thesen zur Vertreibung");
  });

  test("Besprechung: Literaturangabe am Ende, Euro-Zeichen als t", () => {
    const hint = titleHint(OVERY);
    expect(hint.blockOrder).toBe(2);
    expect(hint.zone).toBe("Richard Overy. Warum Krieg?");
    expect(hint.priceCents).toBe(2800);
    expect(hint.queries).toEqual(["Warum Krieg", "Richard Overy"]);
  });

  test("Haupttitel mit Gedankenstrich bleibt eine Anfrage", () => {
    expect(titleHint(UNBEKANNT).queries[0]).toBe("Unbekannt April 1945");
    expect(titleHint(WISNEWSKI).queries).toContain("Verheimlicht vertuscht vergessen 2026");
  });

  test("Beschreibung ohne Titel im Text: Hinweis ohne Anfrage, fuer die Redaktion", () => {
    const hints = findHints(
      article("Nachdem ein Gericht die Vernichtung der Restauflage des Buches „Dokumente …", [
        "Nachdem ein Gericht die Vernichtung der Restauflage des Buches „Dokumente polnischer Grausamkeiten“ angeordnet hatte, hat der herausgebende Verlag das traurige Thema polnischer Verbrechen an Deutschen fortgeschrieben. Neben den polnischen Übergriffen seit 1919 nehmen die Vertreibungsverbrechen breiten Raum ein. 384 S., viele Abb., geb. im Großformat.",
      ]),
    );
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ kind: "title", queries: [], priceCents: null });
  });

  test("Umfangsangabe im eigenen Absatz: Untertitel aus der Beschreibung davor", () => {
    const hint = titleHint(
      article("Wie Deutschland der Erste Weltkrieg aufgezwungen w…", [
        "Wie Deutschland der Erste Weltkrieg aufgezwungen wurde. – Wenn man vom Ukraine-Krieg redet, ist sich der Mainstream schnell einig, mit dem Finger auf Rußland zu zeigen. Stefan Scheil ordnet das alles politisch und historisch ein.",
        "256 Seiten, viele s/w. Abb., geb. im Großformat. t 25,95",
      ]),
    );
    expect(hint.blockOrder).toBe(2);
    expect(hint.priceCents).toBe(2595);
    expect(hint.zone).toBe("Wie Deutschland der Erste Weltkrieg aufgezwungen wurde.");
  });

  test("gewoehnlicher Text liefert nichts", () => {
    expect(
      findHints(
        article("Verrat an der Truppe", [
          "Verrat an der Truppe",
          "Der Bericht umfaßt 300 Seiten, die das Ministerium bis heute unter Verschluß hält.",
          "Die Truppe zählte 120 S., wie es im Tagebuch abgekürzt heißt, und 40 Offiziere.",
          "Der Preis stieg auf € 9,80 je Liter.",
        ]),
      ),
    ).toEqual([]);
  });
});

describe("Zuordnung zum Produkt", () => {
  test("Referenz: genau ein Produkt mit genau dieser Nummer", () => {
    const generale = product(10623, "Die Generale der Waffen-SS", "101208", 2980);
    expect(pickByReference([generale], "101208")).toBe(generale);
    expect(pickByReference([product(1, "Anderes", "1012080", 100)], "101208")).toBeNull();
    expect(pickByReference([generale, { ...generale, id: 2 }], "101208")).toBeNull();
    expect(pickByReference([], "101208")).toBeNull();
  });

  test("Titel, Verfasser und Preis stimmen", () => {
    const thesen = product(2590, "80 Thesen zur Vertreibung", "271165", 1790, "Alfred de Zayas/Konrad Badenheuer");
    const hint = titleHint(THESEN);
    expect(scoreByTitle(thesen, hint)).toBe(6);
    expect(pickByTitle([thesen], hint)).toBe(thesen);
  });

  test("unscharfer Suchtreffer ohne den Namen in der Titelzone faellt weg", () => {
    // Die Suche nach "Warum Krieg" liefert dieses Buch.
    const falsch = product(7791, "Warum mußten Deutschlands Städte sterben?", "255253", 2490, "Günter Zemella");
    expect(scoreByTitle(falsch, titleHint(OVERY))).toBeNull();
    expect(pickByTitle([falsch], titleHint(OVERY))).toBeNull();
  });

  test("anderer Jahrgang desselben Titels verliert gegen den richtigen", () => {
    const neu = product(10645, "Verheimlicht - Vertuscht - Vergessen 2026", "292229", 1800, "Gerhard Wisnewski");
    const alt = product(8160, "Verheimlicht, vertuscht, vergessen", "250000", 1499, "Gerhard Wisnewski");
    expect(pickByTitle([alt, neu], titleHint(WISNEWSKI))).toBe(neu);
  });

  test("gleicher Name, der Preis entscheidet", () => {
    const hint = titleHint(
      article("as Wettrüsten im Kalten Krieg", [
        "as Wettrüsten im Kalten Krieg trieb die militärtechnische Entwicklung voran. Der zweite Band zeigt die Flugzeuge der Jahre 1956 bis 1970 in Wort und Bild, vom Abfangjäger bis zum strategischen Bomber. E.G.",
        "Joachim Schreiber. Militärflugzeuge des Kalten Krieges. Band 2 (1956–1970). 240 S., geb., t 34,90. Stuttgart: Motorbuch Verlag, 2025.",
      ]),
    );
    const band2 = product(10429, "Militärflugzeuge des Kalten Krieges", "290000", 3490, "Joachim Schreiber");
    const band1 = product(9206, "Militärflugzeuge des Kalten Krieges", "280000", 3990, "Joachim Schreiber");
    expect(pickByTitle([band1, band2], hint)).toBe(band2);
  });

  test("zwoelf Baende gleichen Namens und Preises: keine Verknuepfung", () => {
    const hint = titleHint(VETERANEN);
    const baende = [
      product(10639, "Veteranen der Waffen-SS berichten", "284341", 1880, "Rolf Michaelis (Hrsg.)"),
      product(10638, "Veteranen der Waffen-SS berichten", "284338", 1880, "Rolf Michaelis (Hrsg.)"),
      product(10497, "Veteranen der Waffen-SS berichten", "278225", 1780, "Rolf Michaelis (Hrsg.)"),
    ];
    expect(pickByTitle(baende, hint)).toBeNull();
  });

  test("Band steht im Laden am Namen, im Heft hinter dem Untertitel", () => {
    const hint = titleHint(UNBEKANNT);
    const band1 = product(10629, "Unbekannt - April 1945, Band 1", "283104", 4000, "Henrik Schulze");
    const band2 = product(10647, "Unbekannt - April 1945, Band 2", "292388", 6000, "Henrik Schulze");
    expect(scoreByTitle(band2, hint)).toBeNull();
    expect(pickByTitle([band2, band1], hint)).toBe(band1);
  });

  test("ein einzelnes Wort als Name braucht Preis und Verfasser", () => {
    const hint = titleHint(
      article("Kamen die Indogermanen aus der Steppe?", [
        "Kamen die Indogermanen aus der Steppe? Nach der herrschenden „Kurgan-These“ ja. Der Verfasser sichtet die Befunde aus Sprachwissenschaft, Archäologie und Genetik und kommt zu einem anderen Ergebnis. A.L.",
        "Linus Ammer. Indogermanen: Herkunft, Eigenschaften, Expansionsgeschichte. 320 S., geb., € 24,80. Tübingen: Hohenrain, 2025.",
      ]),
    );
    expect(pickByTitle([product(10515, "Indogermanen", "290100", 2480, "Linus Ammer")], hint)).toMatchObject({ id: 10515 });
    expect(pickByTitle([product(10515, "Indogermanen", "290100", 2480, "")], hint)).toBeNull();
    expect(pickByTitle([product(10515, "Indogermanen", "290100", 1990, "Linus Ammer")], hint)).toBeNull();
  });

  test("Name nur als Teil eines anderen Titels, ohne Preis und Verfasser: nichts", () => {
    const hint = titleHint(
      article("Bildband", [
        "Der Erste Weltkrieg in Farbe",
        "Ein Bildband mit bislang unbekannten Aufnahmen von allen Fronten, sorgfältig koloriert und erläutert. 200 S., viele Abb., geb., € 39,–.",
      ]),
    );
    expect(pickByTitle([product(9583, "Der Erste Weltkrieg", "260000", 2990, "Jörg Friedrich")], hint)).toBeNull();
  });
});

describe("Hilfen", () => {
  test("Schluessel haengt an den Woertern, nicht an Trennstrichen und Leerraum", () => {
    expect(blockKey("Art. 101208  t 29,80")).toBe(blockKey("Art. 101208 t 29,80"));
    expect(blockKey("der -Waffen‑SS‑Führer")).toBe(blockKey("der Waffen-SS-Führer"));
    expect(blockKey("Art. 101208 t 29,80")).not.toBe(blockKey("Art. 101209 t 29,80"));
  });

  test("Suchtext ohne Anfuehrungen, Gedankenstriche und Satzzeichen", () => {
    expect(searchQuery("SS‑Kampfgruppe „Böhmen–Mähren“")).toBe("SS Kampfgruppe Böhmen Mähren");
    expect(searchQuery("Der Oberste Kriegsrat 1939/1940:")).toBe("Der Oberste Kriegsrat 1939 1940");
  });

  test("nur Adressen des Ladens", () => {
    expect(isShopUrl("https://lesenundschenken.de/10623-die-generale-der-waffen-ss.html")).toBe(true);
    expect(isShopUrl("https://www.lesenundschenken.de/10623-x.html")).toBe(true);
    expect(isShopUrl("http://lesenundschenken.de/10623-x.html")).toBe(false);
    expect(isShopUrl("https://lesenundschenken.de.example.com/x")).toBe(false);
    expect(isShopUrl("javascript:alert(1)")).toBe(false);
    expect(isShopUrl("")).toBe(false);
  });
});
