/**
 * Offline-Puffer: die zuletzt geoeffnete Ausgabe bleibt ohne Netz lesbar.
 *
 * Faellt am Telefon fuer ein paar Minuten das Netz weg, soll der Leser das
 * Heft, das er offen hat, zu Ende lesen koennen, auch nach dem Neuladen.
 * Dafuer legt der Reader die Ausgabe nebenher im Browser ab
 * (`pufferFuellen.ts`): Seitenkacheln, Artikelbilder, Artikeltexte, die
 * Leseschriften der Sitzung und die Listen (Seiten, Artikel, Verzeichnis).
 *
 * Der Kopierschutz bleibt dabei ganz:
 * - Kacheln und Bilder liegen so, wie das Gateway sie geschickt hat:
 *   verwuerfelt und mit dem Wasserzeichen ihrer Sitzung. Zusammengesetzt
 *   wird erst beim Anzeigen, auf einer Zeichenflaeche (`schutz.ts`).
 * - Der Text liegt verschluesselt wie aus `articles.getForReader`, lesbar
 *   nur mit der Schrift seiner Sitzung.
 * - Jeder Eintrag ist dazu mit AES-GCM verschluesselt. Der Schluessel
 *   entsteht im Browser als nicht exportierbarer CryptoKey und verlaesst ihn
 *   nie; die Namen der Eintraege sind Hashwerte. In den Entwicklerwerkzeugen
 *   oder in einer Kopie des Browserprofils stehen nur Zufallsbytes.
 * - Kein Cache Storage, keine `blob:`-Adresse, keine Datei zum Speichern.
 *
 * Es gibt hoechstens ein Paket, fuer genau eine Ausgabe und ein Konto. Es
 * gilt OFFLINE_FRIST_MS nach der letzten Bestaetigung des Zugriffs durch den
 * Server und verschwindet beim Abmelden, bei entzogenem Zugriff, bei einem
 * anderen Konto und bei offenen Entwicklerwerkzeugen.
 */
import type { FunctionReturnType } from "convex/server";
import type { api } from "../lib/api";
import { fnv1a32 } from "./schutzRechnen";

/** So lange bleibt die Ausgabe ohne Verbindung lesbar. */
export const OFFLINE_FRIST_MS = 72 * 60 * 60 * 1000;
/** Spiel fuer Uhren: wer die Uhr weiter zurueckstellt, verliert das Paket. */
const UHR_SPIEL_MS = 10 * 60 * 1000;

export type SeitenInfo = {
  width: number;
  height: number;
  tileSize: number;
  maxLevel: number;
};

type Fortschritt = {
  mode: "page" | "article";
  pageIndex: number;
  articleId: string | null;
  updatedAt: number;
};

export type PaketKopf = {
  v: 1;
  issueId: string;
  userId: string;
  angelegt: number;
  /** Letzte Bestaetigung des Zugriffs durch den Server. */
  bestaetigt: number;
  /** Spaetester Zeitpunkt, zu dem das Paket benutzt wurde. */
  zuletzt: number;
  watermark: string;
  /** Fingerabdruck der Seitenbilder; ein Neuimport faengt von vorn an. */
  seitenStand: string;
  /** Lesestelle auf diesem Geraet, auch ohne Verbindung gemerkt. */
  fortschritt: Fortschritt | null;
  fertig: boolean;
};

export type PaketDaten = {
  issue: NonNullable<FunctionReturnType<typeof api.issues.getPublic>>;
  pages: FunctionReturnType<typeof api.issuePages.listForReader>;
  articles: FunctionReturnType<typeof api.articles.listForReader>;
  regions: FunctionReturnType<typeof api.articles.regionsForReader>;
  links: FunctionReturnType<typeof api.pageLinks.forReader>;
  products: FunctionReturnType<typeof api.articleProducts.forReader>;
  toc: FunctionReturnType<typeof api.toc.listForReader>;
};

export type PaketArtikel = NonNullable<FunctionReturnType<typeof api.articles.getForReader>>;

/** Ein Artikeltext und der Satz (die Lesesitzung), zu dessen Schrift er passt. */
export type GepufferterArtikel = { satz: string; body: PaketArtikel };

/** Kachel oder Bild, wie vom Gateway gekommen, mit dem Schluessel seiner Sitzung. */
export type Gepuffert = { k: number; verwuerfelt: boolean; daten: ArrayBuffer };

export type Schluesselsatz = { id: string; key: CryptoKey; salz: string };

/**
 * Wo die verschluesselten Eintraege liegen. Im Browser IndexedDB, in den
 * Tests eine Map. Die Namen der Eintraege beginnen mit der Kennung ihres
 * Pakets, damit Reste eines alten Pakets erkennbar sind.
 */
export interface Ablage {
  schluessel(): Promise<Schluesselsatz | undefined>;
  schluesselSetzen(s: Schluesselsatz): Promise<void>;
  lesen(slot: string): Promise<ArrayBuffer | undefined>;
  schreiben(slot: string, wert: ArrayBuffer): Promise<void>;
  hat(slot: string): Promise<boolean>;
  loeschen(slot: string): Promise<void>;
  /** Alles weg, was nicht zum Paket `id` gehoert. */
  fremdeWeg(id: string): Promise<void>;
  /** Die ganze Ablage weg. */
  leeren(): Promise<void>;
}

const DB_NAME = "lv";
const S_SCHLUESSEL = "k";
const S_DATEN = "d";

function anfrage<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((ok, fehler) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fehler(r.error);
  });
}

class IdbAblage implements Ablage {
  private db: Promise<IDBDatabase> | null = null;

  private oeffnen(): Promise<IDBDatabase> {
    this.db ??= new Promise<IDBDatabase>((ok, fehler) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore(S_SCHLUESSEL);
        r.result.createObjectStore(S_DATEN);
      };
      r.onsuccess = () => {
        const db = r.result;
        // Ein anderer Tab loescht die Datenbank (Abmelden): Verbindung frei
        // geben, sonst wartet er.
        db.onversionchange = () => {
          db.close();
          this.db = null;
        };
        ok(db);
      };
      r.onerror = () => fehler(r.error);
      r.onblocked = () => fehler(new Error("Ablage blockiert"));
    }).catch((e) => {
      this.db = null;
      throw e;
    });
    return this.db;
  }

  /** Ein Schritt in einer eigenen Transaktion; Schreiben zaehlt erst mit deren Ende. */
  private async schritt<T>(
    store: string,
    modus: IDBTransactionMode,
    tun: (s: IDBObjectStore) => IDBRequest<T> | void,
  ): Promise<T | undefined> {
    const db = await this.oeffnen();
    return new Promise((ok, fehler) => {
      const tx = db.transaction(store, modus);
      const r = tun(tx.objectStore(store));
      tx.oncomplete = () => ok(r ? r.result : undefined);
      tx.onerror = () => fehler(tx.error);
      tx.onabort = () => fehler(tx.error ?? new Error("Abgebrochen"));
    });
  }

  async schluessel() {
    return (await this.schritt(S_SCHLUESSEL, "readonly", (s) => s.get("p"))) as
      | Schluesselsatz
      | undefined;
  }

  async schluesselSetzen(satz: Schluesselsatz) {
    await this.schritt(S_SCHLUESSEL, "readwrite", (s) => s.put(satz, "p"));
  }

  async lesen(slot: string) {
    return (await this.schritt(S_DATEN, "readonly", (s) => s.get(slot))) as
      | ArrayBuffer
      | undefined;
  }

  async schreiben(slot: string, wert: ArrayBuffer) {
    await this.schritt(S_DATEN, "readwrite", (s) => s.put(wert, slot));
  }

  async hat(slot: string) {
    return ((await this.schritt(S_DATEN, "readonly", (s) => s.count(slot))) ?? 0) > 0;
  }

  async loeschen(slot: string) {
    await this.schritt(S_DATEN, "readwrite", (s) => s.delete(slot));
  }

  async fremdeWeg(id: string) {
    await this.schritt(S_DATEN, "readwrite", (s) => {
      s.delete(IDBKeyRange.upperBound(`${id}/`, true));
      s.delete(IDBKeyRange.lowerBound(`${id}/￿`, true));
    });
  }

  async leeren() {
    // Leeren statt die Datenbank zu loeschen: das Loeschen wartet auf jeden
    // anderen Tab, der sie offen hat, und ein eingefrorener Tab am Telefon
    // antwortet nie.
    await this.schritt(S_DATEN, "readwrite", (s) => s.clear());
    await this.schritt(S_SCHLUESSEL, "readwrite", (s) => s.clear());
  }
}

/** Gibt es die Datenbank schon? Ohne Merker soll sie nicht erst entstehen. */
async function datenbankDa(): Promise<boolean> {
  try {
    if (typeof indexedDB === "undefined" || !indexedDB.databases) return false;
    return (await indexedDB.databases()).some((d) => d.name === DB_NAME);
  } catch {
    return false;
  }
}

/** Fuer die Tests: dieselbe Ablage im Arbeitsspeicher. */
export class SpeicherAblage implements Ablage {
  daten = new Map<string, ArrayBuffer>();
  private satz: Schluesselsatz | undefined;
  async schluessel() {
    return this.satz;
  }
  async schluesselSetzen(s: Schluesselsatz) {
    this.satz = s;
  }
  async lesen(slot: string) {
    return this.daten.get(slot);
  }
  async schreiben(slot: string, wert: ArrayBuffer) {
    this.daten.set(slot, wert);
  }
  async hat(slot: string) {
    return this.daten.has(slot);
  }
  async loeschen(slot: string) {
    this.daten.delete(slot);
  }
  async fremdeWeg(id: string) {
    for (const slot of [...this.daten.keys()]) {
      if (!slot.startsWith(`${id}/`)) this.daten.delete(slot);
    }
  }
  async leeren() {
    this.daten.clear();
    this.satz = undefined;
  }
}

const utf8 = new TextEncoder();
const utf8Lesen = new TextDecoder();

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function zufall(n: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(n)));
}

/** Name eines Eintrags: Paketkennung und ein Hash, der nichts verraet. */
async function slotVon(s: Schluesselsatz, name: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", utf8.encode(`${s.salz}|${name}`));
  return `${s.id}/${hex(new Uint8Array(h).subarray(0, 16))}`;
}

/**
 * Verschluesseln: 12 Byte Zufall, dann der Geheimtext. Der Name des Eintrags
 * ist zugehoerige Angabe; ein vertauschter Eintrag laesst sich nicht oeffnen.
 */
async function zu(s: Schluesselsatz, slot: string, daten: BufferSource): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const geheim = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8.encode(slot) },
    s.key,
    daten,
  );
  const out = new Uint8Array(12 + geheim.byteLength);
  out.set(iv);
  out.set(new Uint8Array(geheim), 12);
  return out.buffer;
}

async function auf(s: Schluesselsatz, slot: string, wert: ArrayBuffer): Promise<ArrayBuffer> {
  const b = new Uint8Array(wert);
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b.slice(0, 12), additionalData: utf8.encode(slot) },
    s.key,
    b.slice(12),
  );
}

/** Kachel oder Bild: Schluessel der Sitzung (4 Byte), verwuerfelt (1 Byte), Bild. */
function packen(k: number, verwuerfelt: boolean, daten: ArrayBuffer): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(5 + daten.byteLength);
  new DataView(out.buffer).setUint32(0, k >>> 0);
  out[4] = verwuerfelt ? 1 : 0;
  out.set(new Uint8Array(daten), 5);
  return out;
}

function entpacken(wert: ArrayBuffer): Gepuffert {
  const dv = new DataView(wert);
  return { k: dv.getUint32(0), verwuerfelt: dv.getUint8(4) === 1, daten: wert.slice(5) };
}

/**
 * Das Paket einer Ausgabe. Kopf und Listen liegen zusaetzlich im Speicher;
 * alles andere wird bei Bedarf gelesen und entschluesselt.
 */
export class Paket {
  daten: PaketDaten | null = null;
  /** Abgeloest (neues Paket, Abmelden): schreibt nichts mehr. */
  tot = false;
  private kopfKette: Promise<void> = Promise.resolve();

  constructor(
    private ablage: Ablage,
    private s: Schluesselsatz,
    public kopf: PaketKopf,
  ) {}

  get id() {
    return this.s.id;
  }

  get issueId() {
    return this.kopf.issueId;
  }

  private async roh(name: string): Promise<ArrayBuffer | null> {
    const slot = await slotVon(this.s, name);
    const wert = await this.ablage.lesen(slot);
    if (!wert) return null;
    try {
      return await auf(this.s, slot, wert);
    } catch {
      return null;
    }
  }

  private async rohAblegen(name: string, daten: BufferSource) {
    if (this.tot) return;
    const slot = await slotVon(this.s, name);
    const wert = await zu(this.s, slot, daten);
    if (!this.tot) await this.ablage.schreiben(slot, wert);
  }

  private async json<T>(name: string): Promise<T | null> {
    const roh = await this.roh(name);
    if (!roh) return null;
    try {
      return JSON.parse(utf8Lesen.decode(roh)) as T;
    } catch {
      return null;
    }
  }

  private jsonAblegen(name: string, wert: unknown) {
    return this.rohAblegen(name, utf8.encode(JSON.stringify(wert)));
  }

  async hat(name: string): Promise<boolean> {
    return this.ablage.hat(await slotVon(this.s, name));
  }

  /** Den gespeicherten Kopf und die Listen lesen. */
  static async oeffnen(ablage: Ablage, s: Schluesselsatz): Promise<Paket | null> {
    const leer = new Paket(ablage, s, null as unknown as PaketKopf);
    const kopf = await leer.json<PaketKopf>("kopf");
    if (!kopf || kopf.v !== 1) return null;
    leer.kopf = kopf;
    leer.daten = await leer.json<PaketDaten>("daten");
    return leer;
  }

  /** Kopf aendern. Geschrieben wird nacheinander, der letzte Stand gewinnt. */
  kopfAendern(aendern: (k: PaketKopf) => void): Promise<void> {
    aendern(this.kopf);
    const stand = JSON.stringify(this.kopf);
    this.kopfKette = this.kopfKette
      .then(() => this.rohAblegen("kopf", utf8.encode(stand)))
      .catch(() => undefined);
    return this.kopfKette;
  }

  async datenSetzen(daten: PaketDaten) {
    this.daten = daten;
    await this.jsonAblegen("daten", daten);
  }

  /** Zugriff vom Server bestaetigt: die Frist beginnt neu. */
  async bestaetigen(jetzt = Date.now()) {
    await this.kopfAendern((k) => {
      k.bestaetigt = jetzt;
      k.zuletzt = Math.max(k.zuletzt, jetzt);
    });
    // Ein abgelaufenes Paket gilt damit wieder; wer es verworfen hat, fragt neu.
    melden();
  }

  seitenInfo(index: number, stand: string) {
    return this.json<SeitenInfo>(`i:${index}:${stand}`);
  }

  seitenInfoAblegen(index: number, stand: string, info: SeitenInfo) {
    return this.jsonAblegen(`i:${index}:${stand}`, info);
  }

  private kachelName(index: number, stand: string, level: number, col: number, row: number) {
    return `t:${index}:${stand}:${level}:${col}:${row}`;
  }

  async kachel(index: number, stand: string, level: number, col: number, row: number) {
    const roh = await this.roh(this.kachelName(index, stand, level, col, row));
    return roh ? entpacken(roh) : null;
  }

  hatKachel(index: number, stand: string, level: number, col: number, row: number) {
    return this.hat(this.kachelName(index, stand, level, col, row));
  }

  kachelAblegen(
    index: number,
    stand: string,
    level: number,
    col: number,
    row: number,
    k: number,
    daten: ArrayBuffer,
  ) {
    return this.rohAblegen(this.kachelName(index, stand, level, col, row), packen(k, true, daten));
  }

  async bild(assetId: string, stand: string) {
    const roh = await this.roh(`b:${assetId}:${stand}`);
    return roh ? entpacken(roh) : null;
  }

  hatBild(assetId: string, stand: string) {
    return this.hat(`b:${assetId}:${stand}`);
  }

  bildAblegen(assetId: string, stand: string, k: number, verwuerfelt: boolean, daten: ArrayBuffer) {
    return this.rohAblegen(`b:${assetId}:${stand}`, packen(k, verwuerfelt, daten));
  }

  artikel(articleId: string) {
    return this.json<GepufferterArtikel>(`a:${articleId}`);
  }

  artikelAblegen(articleId: string, satz: string, body: PaketArtikel) {
    return this.jsonAblegen(`a:${articleId}`, { satz, body } satisfies GepufferterArtikel);
  }

  schrift(satz: string, nr: number) {
    return this.roh(`f:${satz}:${nr}`);
  }

  schriftAblegen(satz: string, nr: number, daten: ArrayBuffer) {
    return this.rohAblegen(`f:${satz}:${nr}`, daten);
  }

  async schriftWeg(satz: string, nr: number) {
    if (this.tot) return;
    await this.ablage.loeschen(await slotVon(this.s, `f:${satz}:${nr}`));
  }
}

/** Gilt das Paket noch fuer dieses Konto? */
export function nochGueltig(kopf: PaketKopf, jetzt: number, userId?: string | null): boolean {
  if (userId && kopf.userId !== userId) return false;
  if (jetzt - kopf.bestaetigt > OFFLINE_FRIST_MS) return false;
  // Uhr zurueckgestellt, um die Frist zu verlaengern.
  if (jetzt < Math.max(kopf.bestaetigt, kopf.zuletzt) - UHR_SPIEL_MS) return false;
  return true;
}

/** Kurzname der Lesesitzung, deren Schrift ein Text braucht. Nicht das Token selbst. */
export function satzVon(sessionToken: string): string {
  const a = fnv1a32(`s:${sessionToken}`).toString(16).padStart(8, "0");
  const b = fnv1a32(`t:${sessionToken}`).toString(16).padStart(8, "0");
  return a + b;
}

/** Fingerabdruck aller Seitenbilder einer Ausgabe. */
export function seitenFingerabdruck(
  pages: ReadonlyArray<{ index: number; stand?: string | null }>,
): string {
  return fnv1a32(pages.map((p) => `${p.index}=${p.stand ?? ""}`).join("|")).toString(16);
}

// --- Das eine Paket dieses Browsers --------------------------------------------

let ablage: Ablage | null = null;
let offen: Promise<Paket | null> | null = null;
const hoerer = new Set<() => void>();
const beimLeeren = new Set<() => void>();
/** Merker in localStorage: es gibt ein Paket. Ohne ihn bleibt IndexedDB zu. */
const MERKER = "lv";
const kanal: BroadcastChannel | null =
  typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("lv");

function holeAblage(): Ablage {
  ablage ??= new IdbAblage();
  return ablage;
}

/** Fuer die Tests: eine andere Ablage und frischer Zustand. */
export function pufferAblageSetzen(a: Ablage | null) {
  ablage = a;
  offen = null;
}

function merker(): boolean {
  try {
    return typeof localStorage === "undefined" || localStorage.getItem(MERKER) === "1";
  } catch {
    return true;
  }
}

function merkerSetzen(an: boolean) {
  try {
    if (typeof localStorage === "undefined") return;
    if (an) localStorage.setItem(MERKER, "1");
    else localStorage.removeItem(MERKER);
  } catch {
    // ohne localStorage bleibt es bei IndexedDB
  }
}

function melden() {
  for (const fn of hoerer) fn();
}

/** Ein anderer Tab hat das Paket ersetzt oder geloescht: neu lesen. */
kanal?.addEventListener("message", () => {
  void offen?.then((p) => {
    if (p) p.tot = true;
  });
  offen = null;
  melden();
});

async function laden(): Promise<Paket | null> {
  if (!merker()) return null;
  const a = holeAblage();
  const s = await a.schluessel();
  if (!s) return null;
  const p = await Paket.oeffnen(a, s);
  // Reste eines abgeloesten Pakets (spaete Schreibvorgaenge) wegraeumen.
  if (p) void a.fremdeWeg(s.id).catch(() => undefined);
  return p;
}

/** Das vorhandene Paket, ohne Pruefung, oder null. */
export function vorhandenesPaket(): Promise<Paket | null> {
  offen ??= laden().catch(() => null);
  return offen;
}

/**
 * Das Paket fuer diese Ausgabe, sofern es noch gilt. Gehoert es einem
 * anderen Konto, faellt es weg. Ist nur die Frist um, bleibt es liegen,
 * wird aber nicht gelesen: mit Verbindung baut das Fuellen darauf auf und
 * bestaetigt es neu (`pufferFuellen.ts`).
 */
export async function paketFuer(
  issueId: string,
  userId: string | null,
  jetzt = Date.now(),
): Promise<Paket | null> {
  const p = await vorhandenesPaket();
  if (!p || p.tot) return null;
  if (userId && p.kopf.userId !== userId) {
    await pufferLeeren();
    return null;
  }
  if (!nochGueltig(p.kopf, jetzt, userId)) return null;
  return p.issueId === issueId ? p : null;
}

/** Neues, leeres Paket. Ein vorhandenes (auch einer anderen Ausgabe) faellt weg. */
export async function neuesPaket(kopf: Omit<PaketKopf, "v">): Promise<Paket> {
  const a = holeAblage();
  const alt = await offen?.catch(() => null);
  if (alt) alt.tot = true;
  await a.leeren();
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const s: Schluesselsatz = { id: zufall(6), key, salz: zufall(16) };
  await a.schluesselSetzen(s);
  const p = new Paket(a, s, { v: 1, ...kopf });
  await p.kopfAendern(() => undefined);
  merkerSetzen(true);
  offen = Promise.resolve(p);
  kanal?.postMessage("neu");
  melden();
  return p;
}

/** Abmelden, Zugriff weg, Entwicklerwerkzeuge: alles weg. */
export async function pufferLeeren(): Promise<void> {
  for (const fn of beimLeeren) fn();
  const alt = await offen?.catch(() => null);
  if (alt) alt.tot = true;
  offen = Promise.resolve(null);
  const da = merker() || (await datenbankDa());
  merkerSetzen(false);
  try {
    if (da) await holeAblage().leeren();
  } catch {
    // ohne IndexedDB gibt es auch nichts zu loeschen
  }
  kanal?.postMessage("weg");
  melden();
}

/** Nur weg, wenn das Paket zu dieser Ausgabe gehoert. */
export async function pufferLeerenFuer(issueId: string): Promise<void> {
  const p = await vorhandenesPaket();
  if (p && p.issueId === issueId) await pufferLeeren();
}

/** Benachrichtigung, wenn ein Paket entsteht oder verschwindet. */
export function pufferBeobachten(fn: () => void): () => void {
  hoerer.add(fn);
  return () => hoerer.delete(fn);
}

/** Wer beim Leeren mithalten muss (Fuellen anhalten, Schriften vergessen). */
export function beimPufferLeeren(fn: () => void): () => void {
  beimLeeren.add(fn);
  return () => beimLeeren.delete(fn);
}

/** Was PageMode aus dem Paket braucht; der Stand jeder Seite steht in der Liste. */
export type SeitenPuffer = {
  info(pageIndex: number): Promise<SeitenInfo | null>;
  infoAblegen(pageIndex: number, info: SeitenInfo): void;
  kachel(pageIndex: number, level: number, col: number, row: number): Promise<Gepuffert | null>;
  kachelAblegen(
    pageIndex: number,
    level: number,
    col: number,
    row: number,
    k: number,
    daten: ArrayBuffer,
  ): void;
};

export function seitenPuffer(
  paket: Paket,
  pages: ReadonlyArray<{ index: number; stand?: string | null }>,
): SeitenPuffer {
  const staende = new Map(pages.map((p) => [p.index, p.stand ?? ""]));
  const stand = (i: number) => staende.get(i) ?? "";
  return {
    info: (i) => paket.seitenInfo(i, stand(i)).catch(() => null),
    infoAblegen: (i, info) => void paket.seitenInfoAblegen(i, stand(i), info).catch(() => undefined),
    kachel: (i, l, c, r) => paket.kachel(i, stand(i), l, c, r).catch(() => null),
    kachelAblegen: (i, l, c, r, k, daten) =>
      void paket.kachelAblegen(i, stand(i), l, c, r, k, daten).catch(() => undefined),
  };
}
