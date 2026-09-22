/**
 * Mehrere Uploads nebeneinander, aber nicht unbegrenzt.
 *
 * Bisher lief der Import streng abwechselnd: eine Seite rendern, sie
 * hochladen, die naechste rendern. Waehrend der Upload lief, stand der
 * Rechner still; waehrend gerendert wurde, lag die Leitung brach. Die
 * Schlange nimmt einen Auftrag entgegen und gibt sofort zurueck, solange noch
 * ein Platz frei ist — so laeuft das Hochladen neben dem Rendern her.
 *
 * Die Grenze ist Absicht: ohne sie stapeln sich bei einem Heft mit 250 Bildern
 * ebenso viele offene Verbindungen, und der Speicher haelt alle Blobs
 * gleichzeitig fest.
 */
export class Ladeschlange {
  private laufend = new Set<Promise<void>>();
  private fehler: unknown = null;

  constructor(private readonly grenze = 4) {}

  /**
   * Einen Auftrag einreihen. Gibt zurueck, sobald ein Platz frei war — nicht
   * erst, wenn der Auftrag fertig ist.
   */
  async einreihen(auftrag: () => Promise<void>): Promise<void> {
    this.wirfFehler();
    while (this.laufend.size >= this.grenze) {
      await Promise.race(this.laufend);
      this.wirfFehler();
    }
    const lauf = auftrag()
      .catch((e) => {
        // Der erste Fehler zaehlt; die spaeteren sind meist seine Folge.
        if (this.fehler === null) this.fehler = e;
      })
      .finally(() => {
        this.laufend.delete(lauf);
      });
    this.laufend.add(lauf);
  }

  /** Warten, bis alles durch ist. Wirft den ersten Fehler. */
  async fertig(): Promise<void> {
    while (this.laufend.size > 0) {
      await Promise.race(this.laufend);
    }
    this.wirfFehler();
  }

  /** Wie viele Auftraege gerade laufen — fuer Anzeige und Tests. */
  get offen(): number {
    return this.laufend.size;
  }

  private wirfFehler(): void {
    if (this.fehler !== null) {
      const e = this.fehler;
      this.fehler = null;
      throw e;
    }
  }
}
