/**
 * Reihenfolge fuer Artikelbilder.
 *
 * Ein bildreicher Artikel fragte alle Bilder auf einmal an. Das Gateway
 * setzt jedes einzeln zusammen (Wasserzeichen, Verwuerfeln) und teilte sich
 * dabei zwischen allen auf: das erste Bild stand erst nach 7 bis 10 Sekunden,
 * kurz vor dem letzten. Jetzt laufen hoechstens ein paar zugleich, und unter
 * den wartenden kommt das mit dem kleinsten Rang zuerst dran — der Rang ist
 * die Stelle im Artikel, oben vor unten.
 */
export class Warteschlange {
  private wartend: { rang: number; los: () => void }[] = [];
  private laufend = 0;

  constructor(private gleichzeitig: number) {}

  /**
   * Wartet auf einen freien Platz. Zurueck kommt die Freigabe, die nach der
   * Arbeit zu rufen ist. Ein Abbruch vor dem Start nimmt den Auftrag heraus.
   */
  platz(rang: number, signal: AbortSignal): Promise<() => void> {
    return new Promise((ok, fehler) => {
      const auftrag = {
        rang,
        los: () => {
          signal.removeEventListener("abort", raus);
          this.laufend += 1;
          let frei = false;
          ok(() => {
            if (frei) return;
            frei = true;
            this.laufend -= 1;
            this.weiter();
          });
        },
      };
      const raus = () => {
        const i = this.wartend.indexOf(auftrag);
        if (i >= 0) this.wartend.splice(i, 1);
        fehler(signal.reason ?? new DOMException("Abgebrochen", "AbortError"));
      };
      if (signal.aborted) {
        raus();
        return;
      }
      signal.addEventListener("abort", raus, { once: true });
      this.wartend.push(auftrag);
      this.weiter();
    });
  }

  private weiter() {
    while (this.laufend < this.gleichzeitig && this.wartend.length > 0) {
      this.wartend.sort((a, b) => a.rang - b.rang);
      this.wartend.shift()!.los();
    }
  }
}

/** Gemeinsam fuer alle Artikelbilder des Lesers. */
export const bildschlange = new Warteschlange(3);
