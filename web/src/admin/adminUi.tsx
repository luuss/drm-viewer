/**
 * Kleine Bausteine der Redaktion.
 *
 * Rueckmeldungen stehen dort, wo gehandelt wurde — nicht oben auf der Seite,
 * wo sie niemand sieht, der gerade unten in einem Heft arbeitet. Felder, die
 * beim Verlassen speichern, sagen kurz "Gespeichert".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { FunctionReturnType } from "convex/server";
import { cleanError, type api } from "../lib/api";

export type Meldung = { art: "ok" | "err"; text: string } | null;

/**
 * `const [meldung, tue, busy] = useMeldung();`
 * `tue(() => mutation(...), "Gespeichert")` meldet Erfolg oder Fehler an
 * der Stelle, an der `<MeldungZeile meldung={meldung} />` steht.
 */
export function useMeldung() {
  const [meldung, setMeldung] = useState<Meldung>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const tue = useCallback(
    async <T,>(fn: () => Promise<T>, ok?: string | ((r: T) => string), label = "x") => {
      setMeldung(null);
      setBusy(label);
      try {
        const r = await fn();
        const text = typeof ok === "function" ? ok(r) : ok;
        if (text) setMeldung({ art: "ok", text });
        return r;
      } catch (e) {
        setMeldung({ art: "err", text: cleanError(e) ?? "Fehler" });
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [],
  );
  return [meldung, tue, busy, setMeldung] as const;
}

export function MeldungZeile({ meldung, klein }: { meldung: Meldung; klein?: boolean }) {
  if (!meldung) return null;
  return (
    <div className={`${meldung.art}${klein ? " small" : ""}`} role={meldung.art === "err" ? "alert" : "status"}>
      {meldung.text}
    </div>
  );
}

/**
 * Speichern beim Verlassen eines Feldes, mit kurzer Bestaetigung daneben.
 * `speichern` bekommt den neuen Wert; unveraenderte Felder speichern nicht.
 */
export function useFeldSpeicher() {
  const [stand, setStand] = useState<"" | "speichert" | "gespeichert" | string>("");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const speichere = useCallback(async (fn: () => Promise<unknown>) => {
    window.clearTimeout(timer.current);
    setStand("speichert");
    try {
      await fn();
      setStand("gespeichert");
      timer.current = window.setTimeout(() => setStand(""), 1800);
    } catch (e) {
      setStand(cleanError(e) ?? "Fehler");
    }
  }, []);
  return [stand, speichere] as const;
}

export function SpeicherStand({ stand }: { stand: string }) {
  if (!stand) return null;
  const fehler = stand !== "speichert" && stand !== "gespeichert";
  return (
    <span className={`speicher-stand${fehler ? " fehler" : ""}`} role={fehler ? "alert" : "status"}>
      {stand === "speichert" ? "Speichert…" : stand === "gespeichert" ? "Gespeichert" : stand}
    </span>
  );
}

// --- Auftraege der Aufbereitung -------------------------------------------

export const JOB_STATUS: Record<string, string> = {
  queued: "wartet",
  claimed: "übernommen",
  running: "läuft",
  review: "fertig",
  done: "fertig",
  error: "fehlgeschlagen",
};

export const JOB_KIND: Record<string, string> = {
  full: "Aufbereitung",
  toc: "Inhaltsverzeichnis-Flächen",
  prepare: "Vorbereitung",
  pdf: "Seiten",
  idml: "Satzdatei",
};

export const jobLaeuft = (status: string | undefined | null) =>
  status === "queued" || status === "claimed" || status === "running";

// --- Heftstatus -------------------------------------------------------------

export type HeftStatus = {
  text: string;
  ton: "live" | "pending" | "excluded" | "";
  schritt: "fehler" | "aufbereitung" | "seiten" | "pruefen" | "bereit" | "live";
};

/** Der eine Satz, der sagt, wo ein Heft steht und was als Naechstes kommt. */
export function heftStatus(i: {
  isPublished: boolean;
  pageCount: number;
  pendingArticles: number;
  lastJob: { status: string; progress: number | null } | null;
}): HeftStatus {
  if (i.lastJob?.status === "error") {
    return { text: "Aufbereitung fehlgeschlagen", ton: "excluded", schritt: "fehler" };
  }
  if (jobLaeuft(i.lastJob?.status)) {
    const p = i.lastJob?.progress;
    return {
      text: `Wird aufbereitet${p ? ` ${Math.round(p)} %` : ""}`,
      ton: "pending",
      schritt: "aufbereitung",
    };
  }
  if (i.isPublished) return { text: "Veröffentlicht", ton: "live", schritt: "live" };
  if (!i.pageCount) return { text: "Ohne Seiten", ton: "pending", schritt: "seiten" };
  if (i.pendingArticles > 0) {
    return {
      text: `${i.pendingArticles} Artikel prüfen`,
      ton: "pending",
      schritt: "pruefen",
    };
  }
  return { text: "Bereit zum Veröffentlichen", ton: "", schritt: "bereit" };
}

// --- Artikelbloecke ---------------------------------------------------------

export const BLOCK_TYP: Record<string, string> = {
  heading: "Überschrift",
  subheading: "Zwischentitel",
  lead: "Vorspann",
  paragraph: "Absatz",
  quote: "Zitat",
  caption: "Bildunterschrift",
  box: "Kasten",
  table: "Tabelle",
  other: "Sonstiges",
};

/** Gedruckte Seitenzahl einer Leseseite, sonst die laufende Nummer. */
export function seitenName(
  labels: Map<number, string | null> | undefined,
  index: number,
): string {
  return labels?.get(index) ?? String(index + 1);
}

// --- Heft im Arbeitsplatz ---------------------------------------------------

export type EditorIssue = NonNullable<FunctionReturnType<typeof api.issues.getForEditor>>;
