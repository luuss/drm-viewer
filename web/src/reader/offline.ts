/**
 * Haken fuer das Lesen ohne Verbindung (`puffer.ts`).
 *
 * "Verbunden" heisst hier: der Browser meldet Netz und die Leitung zu Convex
 * steht. Bricht sie weg, behaelt Convex die Antworten offener Abfragen; was
 * der Reader danach neu braucht (naechster Artikel, naechste Seite), kommt
 * aus dem Puffer.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { useConvex } from "convex/react";
import { useAuthToken } from "@convex-dev/auth/react";
import { nochGueltig, paketFuer, pufferBeobachten, vorhandenesPaket, type Paket } from "./puffer";

function useNetz(): boolean {
  const [netz, setNetz] = useState(() => navigator.onLine);
  useEffect(() => {
    const an = () => setNetz(true);
    const aus = () => setNetz(false);
    window.addEventListener("online", an);
    window.addEventListener("offline", aus);
    return () => {
      window.removeEventListener("online", an);
      window.removeEventListener("offline", aus);
    };
  }, []);
  return netz;
}

/** Steht die Leitung zum Server? Neu gezeichnet wird nur beim Wechsel. */
export function useVerbunden(): boolean {
  const convex = useConvex();
  const leitung = useSyncExternalStore(
    (melden) => convex.subscribeToConnectionState(melden),
    () => convex.connectionState().isWebSocketConnected,
  );
  return useNetz() && leitung;
}

/**
 * Keine Verbindung, und zwar nicht nur fuer einen Augenblick: beim Start
 * braucht die Leitung einen Moment, und ein kurzes Wackeln soll den Reader
 * nicht umschalten. Meldet der Browser selbst kein Netz, gilt das sofort.
 */
export function useOhneVerbindung(geduldMs = 2500): boolean {
  const verbunden = useVerbunden();
  const netz = useNetz();
  const [lange, setLange] = useState(false);
  useEffect(() => {
    setLange(false);
    if (verbunden) return;
    const timer = window.setTimeout(() => setLange(true), geduldMs);
    return () => window.clearTimeout(timer);
  }, [verbunden, geduldMs]);
  return !verbunden && (!netz || lange);
}

/** Konto hinter dem gespeicherten Anmeldetoken (`sub` = "<userId>|<sitzung>"). */
export function jwtNutzer(token: string | null | undefined): string | null {
  if (!token) return null;
  try {
    const teil = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const sub = JSON.parse(atob(teil.padEnd(Math.ceil(teil.length / 4) * 4, "="))).sub;
    return typeof sub === "string" ? sub.split("|")[0] || null : null;
  } catch {
    return null;
  }
}

/** Das angemeldete Konto, auch ohne Verbindung (aus dem gespeicherten Token). */
export function useKonto(): string | null {
  return jwtNutzer(useAuthToken());
}

/** Bei jeder Aenderung am Puffer (neues Paket, geleert, bestaetigt) neu zaehlen. */
function usePufferStand(): number {
  const [stand, setStand] = useState(0);
  useEffect(() => pufferBeobachten(() => setStand((n) => n + 1)), []);
  return stand;
}

/**
 * Das gueltige Paket dieser Ausgabe fuer dieses Konto. `undefined` solange
 * es gesucht wird, `null` wenn es keins gibt.
 */
export function useLesepuffer(issueId: string | null, userId: string | null) {
  const [paket, setPaket] = useState<Paket | null | undefined>(undefined);
  const stand = usePufferStand();
  useEffect(() => {
    if (!issueId) {
      setPaket(null);
      return;
    }
    let aus = false;
    paketFuer(issueId, userId)
      .then((p) => !aus && setPaket(p))
      .catch(() => !aus && setPaket(null));
    // Die Frist kann waehrend des Lesens ablaufen (lange ohne Verbindung).
    const timer = window.setInterval(() => {
      paketFuer(issueId, userId)
        .then((p) => !aus && setPaket(p))
        .catch(() => undefined);
    }, 60_000);
    return () => {
      aus = true;
      window.clearInterval(timer);
    };
  }, [issueId, userId, stand]);
  return paket;
}

/**
 * Darf der Reader dieser Ausgabe ohne Server oeffnen? Nur mit gueltigem
 * Paket, nur fuer das Konto, das noch angemeldet ist, und nur, wenn wirklich
 * keine Verbindung da ist.
 */
export function useOfflineLeser(issueId: string | null): boolean {
  const userId = useKonto();
  const paket = useLesepuffer(userId ? issueId : null, userId);
  const ohne = useOhneVerbindung();
  return !!paket && ohne;
}

/** Die gespeicherte Ausgabe dieses Kontos, fuer den Hinweis ohne Verbindung. */
export function useGespeicherteAusgabe(): { issueId: string; title: string } | null {
  const userId = useKonto();
  const stand = usePufferStand();
  const [ausgabe, setAusgabe] = useState<{ issueId: string; title: string } | null>(null);
  useEffect(() => {
    let aus = false;
    if (!userId) {
      setAusgabe(null);
      return;
    }
    vorhandenesPaket()
      .then((p) => {
        if (aus) return;
        const titel = p?.daten?.issue.title;
        setAusgabe(
          p && !p.tot && titel && nochGueltig(p.kopf, Date.now(), userId)
            ? { issueId: p.issueId, title: titel }
            : null,
        );
      })
      .catch(() => !aus && setAusgabe(null));
    return () => {
      aus = true;
    };
  }, [userId, stand]);
  return ausgabe;
}
