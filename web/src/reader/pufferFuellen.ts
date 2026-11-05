/**
 * Fuellt den Offline-Puffer (`puffer.ts`) mit der offenen Ausgabe, nebenher
 * und ohne dem Leser im Weg zu stehen.
 *
 * Reihenfolge: die Listen, dann Seite fuer Seite ab der aufgeschlagenen:
 * Seitenmasse, die Kacheln von grob nach fein bis Stufe 1, dazu die Bilder
 * der Artikel dieser Seite. Schriften und Texte kommen nebenher. Springt der Leser, geht es dort weiter. Stufe 0, die volle
 * Aufloesung, kaeme auf ein Vielfaches an Daten (35 Kacheln je Seite statt
 * 17); von ihr liegt nur im Puffer, was der Leser schon vergroessert hat.
 *
 * Ein Durchgang gehoert zu einer Lesesitzung. Eine neue Sitzung desselben
 * Hefts baut auf dem vorhandenen Paket auf: Kacheln und Bilder tragen den
 * Schluessel ihrer eigenen Sitzung und bleiben brauchbar. Nur die Texte
 * kommen neu, damit sie zur Schrift der laufenden Sitzung passen.
 *
 * Das Gateway bremst je Leser und Heft (`tile-service/main.py`). Das Fuellen
 * laeuft darum mit wenigen Anfragen zugleich, kurzen Pausen und wartet,
 * solange der Reader selbst etwas zum Anzeigen holt (`vorrang.ts`).
 */
import type { ConvexReactClient } from "convex/react";
import { api, TILE_SERVICE_URL, type Id } from "../lib/api";
import { mitTicket, NEBENHER, satzSchriften } from "./schutz";
import { mitWiederholung } from "./nachladen";
import { liveLaeuft } from "./vorrang";
import {
  beimPufferLeeren,
  neuesPaket,
  satzVon,
  seitenFingerabdruck,
  type Paket,
  type PaketArtikel,
  type SeitenInfo,
  vorhandenesPaket,
} from "./puffer";

export type Fuellauftrag = {
  issueId: Id<"issues">;
  userId: string;
  sessionToken: string;
  /** Schluessel der Sitzung zum Zusammensetzen der Kacheln und Bilder. */
  k: number;
  watermark: string;
  convex: Pick<ConvexReactClient, "query">;
  /** Die aufgeschlagene Seite: von dort an wird gefuellt. */
  position: () => number;
};

/** Feinste Kachelstufe im Puffer; 0 waere die volle Aufloesung. */
export const FEINSTE_STUFE = 1;
/** Das Gateway rechnet Puffer-Anfragen ohnehin nacheinander (`puffer_spur`). */
const GLEICHZEITIG = 2;
const ARTIKEL_GLEICHZEITIG = 4;
/** Kurze Pause nach jedem Abruf, damit das Gateway Luft behaelt. */
const ABSTAND_MS = 40;
/** Laenger wartet das Fuellen nicht auf die Anzeige. */
const VORRANG_MAX_MS = 4000;
/** Ohne Netz: so lange bis zum naechsten Versuch, wenn kein `online` kommt. */
const NETZ_WARTEN_MS = 15_000;

/** Die Lesesitzung gilt nicht mehr (abgelaufen, abgemeldet, kein Zugriff). */
class SitzungWeg extends Error {}

/** Antwort des Gateways, die kein Erfolg war. */
class Antwort extends Error {
  constructor(public status: number) {
    super(`Status ${status}`);
  }
}

/** Alle Kacheln einer Seite von der grobsten Stufe bis `feinste`. */
export function kachelPlan(
  info: SeitenInfo,
  feinste = FEINSTE_STUFE,
): Array<[level: number, col: number, row: number]> {
  const out: Array<[number, number, number]> = [];
  const bis = Math.max(0, Math.min(feinste, info.maxLevel));
  for (let level = info.maxLevel; level >= bis; level--) {
    // Wie das Gateway: die Stufengroesse aufgerundet.
    const scale = 2 ** level;
    const breite = Math.max(1, Math.ceil(info.width / scale));
    const hoehe = Math.max(1, Math.ceil(info.height / scale));
    const spalten = Math.ceil(breite / info.tileSize);
    const zeilen = Math.ceil(hoehe / info.tileSize);
    for (let row = 0; row < zeilen; row++) {
      for (let col = 0; col < spalten; col++) out.push([level, col, row]);
    }
  }
  return out;
}

/**
 * Die naechste Seite: die erste offene ab der aufgeschlagenen, am Ende des
 * Hefts geht es vorne weiter.
 */
export function naechsteSeite(offen: ReadonlySet<number>, position: number, anzahl: number) {
  let beste = -1;
  let abstand = Infinity;
  for (const p of offen) {
    const d = (((p - position) % anzahl) + anzahl) % anzahl;
    if (d < abstand) {
      abstand = d;
      beste = p;
    }
  }
  return beste;
}

function abgebrochen(signal: AbortSignal) {
  return signal.reason ?? new DOMException("Abgebrochen", "AbortError");
}

function warten(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((ok, fehler) => {
    if (signal.aborted) {
      fehler(abgebrochen(signal));
      return;
    }
    const stopp = () => {
      clearTimeout(timer);
      fehler(abgebrochen(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stopp);
      ok();
    }, ms);
    signal.addEventListener("abort", stopp, { once: true });
  });
}

/** Warten, solange der Reader selbst Kacheln oder Bilder holt. */
async function vorrangAbwarten(signal: AbortSignal) {
  const bis = Date.now() + VORRANG_MAX_MS;
  while (liveLaeuft() && Date.now() < bis) await warten(100, signal);
}

/** Bis das Netz wieder da ist (`online`) oder eine Weile vergangen ist. */
async function wiederDa(signal: AbortSignal) {
  await new Promise<void>((ok) => {
    const fertig = () => {
      clearTimeout(timer);
      globalThis.removeEventListener?.("online", fertig);
      signal.removeEventListener("abort", fertig);
      ok();
    };
    const timer = setTimeout(fertig, NETZ_WARTEN_MS);
    globalThis.addEventListener?.("online", fertig);
    signal.addEventListener("abort", fertig, { once: true });
  });
  if (signal.aborted) throw abgebrochen(signal);
}

function istNetzfehler(e: unknown) {
  return e instanceof TypeError;
}

/**
 * Ein Schritt mit Geduld: ohne Netz wird gewartet und neu versucht, eine
 * abgelaufene Sitzung beendet den Durchgang, alles andere (Seite nicht
 * aufbereitet, Bild weg) wird uebersprungen.
 */
async function versuchen<T>(tun: () => Promise<T>, signal: AbortSignal): Promise<T | null> {
  let verweigert = 0;
  for (;;) {
    if (signal.aborted) throw abgebrochen(signal);
    try {
      return await tun();
    } catch (e) {
      if (signal.aborted || e instanceof SitzungWeg) throw e;
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      // Speicher des Geraets voll: weiterholen hiesse nur, Daten wegzuwerfen.
      if (e instanceof DOMException && e.name === "QuotaExceededError") throw e;
      const status =
        e instanceof Antwort
          ? e.status
          : Number(/^Tickets (\d{3})$/.exec(e instanceof Error ? e.message : "")?.[1] ?? 0);
      if (status === 401) throw new SitzungWeg();
      // 403: Sitzung fuer ein anderes Heft oder ein verbrauchtes Ticket. Ein
      // frisches Ticket hilft beim zweiten; bleibt es dabei, ist die Sitzung weg.
      if (status === 403) {
        verweigert += 1;
        if (verweigert > 2) throw new SitzungWeg();
        continue;
      }
      if (status === 429) {
        await warten(10_000, signal);
        continue;
      }
      if (istNetzfehler(e)) {
        await wiederDa(signal);
        continue;
      }
      return null;
    }
  }
}

/** Hoechstens `n` Arbeiten zugleich. */
async function gleichzeitig<T>(
  liste: readonly T[],
  n: number,
  signal: AbortSignal,
  tun: (eintrag: T) => Promise<void>,
) {
  let i = 0;
  const spur = async () => {
    while (i < liste.length) {
      if (signal.aborted) throw abgebrochen(signal);
      await tun(liste[i++]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, liste.length) }, spur));
}

async function gateway(
  url: string,
  a: Fuellauftrag,
  signal: AbortSignal,
  mitEinmalTicket: boolean,
): Promise<Response> {
  const res = await mitWiederholung(
    () =>
      mitEinmalTicket
        ? mitTicket(url, a.sessionToken, a.issueId, signal, true)
        : fetch(url, { headers: { "X-Tile-Session": a.sessionToken, ...NEBENHER }, signal }),
    signal,
  );
  if (!res.ok) throw new Antwort(res.status);
  return res;
}

async function seiteFuellen(
  paket: Paket,
  a: Fuellauftrag,
  seite: number,
  stand: string,
  signal: AbortSignal,
) {
  const basis = `${TILE_SERVICE_URL}/api/issue/${a.issueId}/page/${seite}`;
  const info =
    (await paket.seitenInfo(seite, stand)) ??
    (await versuchen(async () => {
      await vorrangAbwarten(signal);
      const res = await gateway(`${basis}/info`, a, signal, false);
      const geholt = (await res.json()) as SeitenInfo;
      await paket.seitenInfoAblegen(seite, stand, geholt);
      return geholt;
    }, signal));
  if (!info) return;
  await gleichzeitig(kachelPlan(info), GLEICHZEITIG, signal, async ([level, col, row]) => {
    if (await paket.hatKachel(seite, stand, level, col, row)) return;
    await versuchen(async () => {
      await vorrangAbwarten(signal);
      const res = await gateway(`${basis}/tile/${level}/${col}/${row}.jpg`, a, signal, true);
      await paket.kachelAblegen(seite, stand, level, col, row, a.k, await res.arrayBuffer());
      await warten(ABSTAND_MS, signal);
    }, signal);
  });
}

type Bildauftrag = { url: string; assetId: string; stand: string };

async function bilderFuellen(
  paket: Paket,
  a: Fuellauftrag,
  liste: readonly Bildauftrag[],
  signal: AbortSignal,
) {
  await gleichzeitig(liste, GLEICHZEITIG, signal, async (b) => {
    if (await paket.hatBild(b.assetId, b.stand)) return;
    await versuchen(async () => {
      await vorrangAbwarten(signal);
      const res = await gateway(b.url, a, signal, true);
      const verwuerfelt = res.headers.get("X-V") === "1";
      await paket.bildAblegen(b.assetId, b.stand, a.k, verwuerfelt, await res.arrayBuffer());
      await warten(ABSTAND_MS, signal);
    }, signal);
  });
}

/** Ein ganzer Durchgang fuer eine Lesesitzung. */
export async function fuellen(a: Fuellauftrag, signal: AbortSignal): Promise<void> {
  const satz = satzVon(a.sessionToken);
  const q = a.convex;
  const args = { issueId: a.issueId };
  const [issue, pages, articles, regions, links, products, toc] = await Promise.all([
    q.query(api.issues.getPublic, args),
    q.query(api.issuePages.listForReader, args),
    q.query(api.articles.listForReader, args),
    q.query(api.articles.regionsForReader, args),
    q.query(api.pageLinks.forReader, args),
    q.query(api.articleProducts.forReader, args),
    q.query(api.toc.listForReader, args),
  ]);
  // Ohne Zugriff liefern die Listen nichts, und es gibt nichts zu puffern.
  if (signal.aborted || !issue?.owned || pages.length === 0) return;

  const jetzt = Date.now();
  const fingerabdruck = seitenFingerabdruck(pages);
  // Der Zugriff ist eben bestaetigt (`owned`); ein altes Paket desselben
  // Kontos und Hefts taugt also weiter, auch nach Ablauf der Offline-Frist.
  // Neu importierte Seiten dagegen: die alten Kacheln passen nicht mehr.
  const vorhanden = await vorhandenesPaket();
  if (signal.aborted) return;
  const eigenes =
    vorhanden && !vorhanden.tot && vorhanden.issueId === a.issueId && vorhanden.kopf.userId === a.userId
      ? vorhanden
      : null;
  let paket = eigenes?.kopf.seitenStand === fingerabdruck ? eigenes : null;
  if (!paket) {
    paket = await neuesPaket({
      issueId: a.issueId,
      userId: a.userId,
      angelegt: jetzt,
      bestaetigt: jetzt,
      zuletzt: jetzt,
      watermark: a.watermark,
      seitenStand: fingerabdruck,
      fortschritt: eigenes?.kopf.fortschritt ?? null,
      fertig: false,
    });
  }
  if (signal.aborted) return;
  await paket.datenSetzen({ issue, pages, articles, regions, links, products, toc });
  await paket.kopfAendern((k) => {
    k.bestaetigt = jetzt;
    k.zuletzt = Math.max(k.zuletzt, jetzt);
    k.watermark = a.watermark;
    k.fertig = false;
  });

  // Schriften und Texte laufen neben den Seiten her, nicht davor: ein
  // Weltkrieg-Heft ist ein einziger grosser Text (300 KB), und bis er da war,
  // stand das Fuellen der Seiten (gemessen 05.11.2026: bis zu 20 s, in denen
  // ohne Netz nur die eine angezeigte Seite da gewesen waere).
  const textStand: { bilder: Map<number, Bildauftrag[]> | null } = { bilder: null };
  const texteLauf = (async () => {
    // Schriften dieser Sitzung; ohne sie sind die Texte nicht lesbar.
    await versuchen(
      () =>
        satzSchriften(satz, {
          paket,
          issueId: a.issueId,
          sessionToken: a.sessionToken,
          liveSatz: satz,
        }),
      signal,
    );
    textStand.bilder = bilderJeSeite(await texteFuellen(paket, a, articles, satz, signal));
  })();
  // Gewartet wird unten; ein Fehler (Sitzung weg, Abbruch) kommt dort an.
  texteLauf.catch(() => undefined);

  const staende = new Map(pages.map((p) => [p.index, p.stand ?? ""]));
  const offen = new Set(pages.map((p) => p.index));
  const anzahl = Math.max(...offen) + 1;
  while (offen.size > 0) {
    if (signal.aborted) return;
    const seite = naechsteSeite(offen, a.position(), anzahl);
    offen.delete(seite);
    await seiteFuellen(paket, a, seite, staende.get(seite) ?? "", signal);
    // Die Bilder einer Seite, sobald die Texte (mit der Liste der Bilder) da sind.
    const bilder = textStand.bilder;
    if (bilder) {
      await bilderFuellen(paket, a, bilder.get(seite) ?? [], signal);
      bilder.delete(seite);
    }
  }
  await texteLauf;
  // Bilder der Seiten, die schon vor den Texten fertig waren, ab der Lesestelle.
  const bilder = textStand.bilder ?? new Map<number, Bildauftrag[]>();
  const rest = new Set(bilder.keys());
  while (rest.size > 0) {
    if (signal.aborted) return;
    const seite = naechsteSeite(rest, a.position(), Math.max(anzahl, ...rest) + 1);
    rest.delete(seite);
    await bilderFuellen(paket, a, bilder.get(seite) ?? [], signal);
  }
  if (!signal.aborted) await paket.kopfAendern((k) => (k.fertig = true));
}

/**
 * Alle Texte zur Schrift dieser Sitzung. Bis ein Text neu da ist, bleibt
 * der alte mit seiner Schrift stehen; sind alle neu, fallen die alten
 * Schriften weg.
 */
async function texteFuellen(
  paket: Paket,
  a: Fuellauftrag,
  articles: ReadonlyArray<{ _id: Id<"articles"> }>,
  satz: string,
  signal: AbortSignal,
): Promise<Map<string, PaketArtikel>> {
  const texte = new Map<string, PaketArtikel>();
  const alteSaetze = new Set<string>();
  await gleichzeitig(articles, ARTIKEL_GLEICHZEITIG, signal, async (art) => {
    const da = await paket.artikel(art._id);
    if (da?.satz === satz) {
      texte.set(art._id, da.body);
      return;
    }
    if (da) alteSaetze.add(da.satz);
    const body = await versuchen(
      () =>
        a.convex.query(api.articles.getForReader, {
          articleId: art._id,
          sessionToken: a.sessionToken,
        }),
      signal,
    );
    if (body) {
      await paket.artikelAblegen(art._id, satz, body);
      texte.set(art._id, body);
    } else if (da) {
      texte.set(art._id, da.body);
    }
  });
  if (articles.every((art) => texte.has(art._id))) {
    for (const alt of alteSaetze) {
      if (alt === satz) continue;
      for (let nr = 0; nr < 3; nr++) await paket.schriftWeg(alt, nr).catch(() => undefined);
    }
  }
  return texte;
}

/** Bilder nach der Seite, auf der sie im Heft stehen. */
function bilderJeSeite(texte: ReadonlyMap<string, PaketArtikel>): Map<number, Bildauftrag[]> {
  const bilder = new Map<number, Bildauftrag[]>();
  for (const body of texte.values()) {
    for (const img of body.images) {
      const assetId = /\/api\/asset\/([^/?.]+)\.jpg/.exec(img.url ?? "")?.[1];
      if (!img.url || !assetId) continue;
      const seite = img.page ?? body.pageStart;
      const liste = bilder.get(seite) ?? [];
      liste.push({ url: img.url, assetId, stand: img.stand ?? "" });
      bilder.set(seite, liste);
    }
  }
  return bilder;
}

let lauf: {
  issueId: string;
  token: string;
  abbruch: AbortController;
  position: () => number;
} | null = null;

/** Abmelden, Zugriff weg: kein Fuellen mehr. */
export function pufferAnhalten() {
  lauf?.abbruch.abort();
  lauf = null;
}
beimPufferLeeren(pufferAnhalten);

/**
 * Die offene Ausgabe puffern. Ein Durchgang je Sitzung; laeuft er schon,
 * folgt er nur der neuen Lesestelle. Er laeuft weiter, wenn der Leser in die
 * Bibliothek geht, bis eine andere Ausgabe ihn abloest.
 *
 * Mehrere Tabs: wer zuletzt ein Heft oeffnet, fuellt (Web Locks, `steal`);
 * dem anderen Tab wird das Recht entzogen, und er hoert auf.
 */
export function pufferFuellen(a: Fuellauftrag): void {
  if (lauf && lauf.issueId === a.issueId && lauf.token === a.sessionToken) {
    lauf.position = a.position;
    return;
  }
  lauf?.abbruch.abort();
  const abbruch = new AbortController();
  const dieser = { issueId: a.issueId, token: a.sessionToken, abbruch, position: a.position };
  lauf = dieser;
  const auftrag: Fuellauftrag = { ...a, position: () => dieser.position() };
  const los = () =>
    fuellen(auftrag, abbruch.signal)
      .catch(() => undefined)
      .finally(() => {
        if (lauf === dieser) lauf = null;
      });
  const sperren = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (sperren) {
    sperren.request("lv", { steal: true }, () => los()).catch(() => abbruch.abort());
  } else {
    void los();
  }
}
