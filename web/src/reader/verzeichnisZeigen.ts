/**
 * Gibt es fuer dieses Heft ein Inhaltsverzeichnis im Leser?
 *
 * Im Buch-Modus (Weltkrieg-Leser) ist ein Heft ein durchgehender Text. Ein
 * Verzeichnis hat es nur, wenn das Heft eines druckt (WELTKRIEG-Magazin,
 * `extract-service/extractor/buch_verzeichnis.py`); sonst steht darin nur
 * ein Eintrag, der Titel des Textes, und Knopf und Leiste "Inhalt" entfallen.
 * Solange die Eintraege laden, bleibt es aus: die meisten Hefte haben keins.
 *
 * Zeitschriften (Lesen und Schenken) zeigen das Verzeichnis immer, auch
 * leer — dort sagt die Leiste dann, dass keins hinterlegt ist.
 */
export function verzeichnisZeigen(buch: boolean, eintraege: number | undefined): boolean {
  if (!buch) return true;
  return (eintraege ?? 0) >= 2;
}
