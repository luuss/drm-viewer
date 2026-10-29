/** Was der Leser von einem Ladeauftrag (ImageJob) von OpenSeadragon braucht. */
export type KachelAuftrag = {
  src: string;
  userData: Record<string, unknown>;
  /** Solange der Auftrag laeuft, gesetzt; nach finish/fail oder Zeitablauf leer. */
  jobId: unknown;
  finish: (daten: unknown, request: null, typ: string) => void;
  fail: (fehler: string, request: null) => void;
};

/**
 * Holt eine Kachel: `signal` bricht ab, `aktuell()` sagt, ob sich die Arbeit
 * noch lohnt (zwischen zwei Versuchen fragen).
 */
export type KachelHolen = (
  src: string,
  signal: AbortSignal,
  aktuell: () => boolean,
) => Promise<unknown>;

/**
 * Ladeketten fuer die Kacheln einer aufgeschlagenen Seite.
 *
 * Eine Kette (Ticket holen, laden, bei 429 warten und neu versuchen) laeuft
 * bis zu einer halben Minute. OpenSeadragon bricht sie nie selbst ab: nach
 * seinem Zeitlimit ruft es nur fail(), ein eigener Neuversuch ruft
 * downloadTileStart fuer denselben Auftrag noch einmal, und Schliessen beim
 * Blaettern beendet laufende Auftraege nicht. Alte Ketten liefen so weiter,
 * frassen das Minutenfenster des Gateways und Tickets, und ihr spaetes fail()
 * beendete den neuen Versuch derselben Kachel, die dann leer blieb.
 *
 * Darum: eine neue Kette fuer dieselbe Kachel bricht die alte ab, finish und
 * fail gehen nur an den aktuellen Versuch eines noch laufenden Auftrags, und
 * `alleAbbrechen` beendet beim Blaettern jede Kette der Seite. Was
 * OpenSeadragon danach noch fuer die alte Seite startet (Neuversuch nach
 * dem Zeitlimit), scheitert sofort, ohne Anfrage.
 */
export function kachelLader(holen: KachelHolen) {
  const laufend = new Map<string, AbortController>();
  let geschlossen = false;

  return {
    start(auftrag: KachelAuftrag) {
      if (geschlossen) {
        auftrag.fail("Seite geschlossen", null);
        return;
      }
      laufend.get(auftrag.src)?.abort();
      (auftrag.userData.abbruch as AbortController | undefined)?.abort();
      const abbruch = new AbortController();
      const versuch = {};
      auftrag.userData.abbruch = abbruch;
      auftrag.userData.versuch = versuch;
      laufend.set(auftrag.src, abbruch);
      const aktuell = () =>
        !abbruch.signal.aborted && auftrag.userData.versuch === versuch && !!auftrag.jobId;
      holen(auftrag.src, abbruch.signal, aktuell)
        .then(
          (daten) => {
            if (aktuell()) auftrag.finish(daten, null, "context2d");
          },
          (fehler) => {
            if (aktuell()) auftrag.fail(String(fehler), null);
          },
        )
        .finally(() => {
          // Kein Grund mehr zu laufen: auch die letzte Anfrage abbrechen.
          abbruch.abort();
          if (laufend.get(auftrag.src) === abbruch) laufend.delete(auftrag.src);
        });
    },

    /** downloadTileAbort: OpenSeadragon ruft danach selbst fail(). */
    abbrechen(auftrag: KachelAuftrag) {
      (auftrag.userData.abbruch as AbortController | undefined)?.abort();
    },

    alleAbbrechen() {
      geschlossen = true;
      for (const abbruch of laufend.values()) abbruch.abort();
      laufend.clear();
    },

    /** Fuer Tests: wie viele Ketten noch laufen. */
    get anzahl() {
      return laufend.size;
    },
  };
}
