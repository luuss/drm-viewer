/**
 * Zeichner fuer jeden OpenSeadragon-Betrachter (Seitenansicht, Galerie).
 *
 * Ab Version 5 zeichnet OpenSeadragon von sich aus mit WebGL. Auf Firefox
 * 159 mit Intel-Grafik (HD 4600, Mesa 25, X11) vertauschte dieser Weg Rot und
 * Blau: das Orange von Blitzkrieg wurde blau, Gelb tuerkis (05.11.2026). Am
 * selben Rechner zeichneten Bild, 2D-Canvas und der Kopierschutz
 * (`schutz.ts`, `zusammensetzen`) richtig, ebenso der Canvas-Zeichner von
 * OpenSeadragon; `willReadFrequently` half beim WebGL-Weg nicht. Der Leser
 * zeigt hoechstens zwei Seiten, dafuer reicht der Canvas-Zeichner.
 */
export const OSD_ZEICHNER = "canvas" as const;
