import { useEffect, useRef, useState } from "react";

/** Tasten, die kopieren, sichern, drucken oder den Quelltext zeigen. */
function gesperrteTaste(e: KeyboardEvent): boolean {
  const k = e.key.toLowerCase();
  if (e.key === "F12" || e.key === "PrintScreen") return true;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && ["c", "x", "a", "s", "p", "u"].includes(k)) return true;
  if (mod && (e.shiftKey || e.altKey) && ["i", "j", "c", "k", "s"].includes(k)) return true;
  return false;
}

function leereZwischenablage() {
  try {
    void navigator.clipboard?.writeText(" ");
  } catch {
    // Ohne Rechte keine Zwischenablage, dann bleibt es beim Verdecken.
  }
}

/**
 * Kopierschutz des Readers, solange er offen ist.
 *
 * Kein Rechtsklick, kein Markieren, Kopieren, Ziehen oder Drucken. Verliert
 * das Fenster den Fokus, wechselt der Leser den Tab oder verlaesst der
 * Mauszeiger das Fenster, liefert der Haken `true`: der Reader verschwimmt,
 * bis der Leser zurueck ist. Das trifft auch die meisten Bildschirmfoto-
 * Werkzeuge, die zuerst den Fokus nehmen.
 */
export function useKopierschutz(): [boolean, () => void] {
  const [verdeckt, setVerdeckt] = useState(
    () => document.visibilityState !== "visible" || !document.hasFocus(),
  );

  // Warum der Reader verdeckt ist. Die Maus deckt nur auf, was sie selbst
  // verdeckt hat: erscheint die Abdeckung unter dem stehenden Zeiger, meldet
  // Chrome ein `mouseover`, und das nahm sonst die Abdeckung der Druck-Taste
  // sofort wieder weg.
  const grund = useRef<"maus" | "fokus" | "taste" | null>(null);

  useEffect(() => {
    const verdecke = (warum: "maus" | "fokus" | "taste") => {
      if (warum !== "maus" || grund.current === null) grund.current = warum;
      setVerdeckt(true);
    };
    const sperren = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const taste = (e: KeyboardEvent) => {
      if (!gesperrteTaste(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "PrintScreen") {
        leereZwischenablage();
        verdecke("taste");
      }
    };
    // PrintScreen kommt unter Windows oft nur als keyup an.
    const tasteHoch = (e: KeyboardEvent) => {
      if (e.key !== "PrintScreen") return;
      leereZwischenablage();
      verdecke("taste");
    };
    const weg = () => verdecke("fokus");
    // Fokus zurueck deckt auf, ausser nach der Druck-Taste: dann erst per Klick.
    const zurueck = () => {
      if (grund.current === "taste") return;
      if (document.visibilityState === "visible" && document.hasFocus()) {
        grund.current = null;
        setVerdeckt(false);
      }
    };
    const sichtbarkeit = () =>
      document.visibilityState === "visible" ? zurueck() : verdecke("fokus");
    // Maus verlaesst das Fenster: `relatedTarget` ist dann leer.
    const mausRaus = (e: MouseEvent) => {
      if (!e.relatedTarget) verdecke("maus");
    };
    const mausRein = () => {
      if (grund.current === "maus") zurueck();
    };
    const druck = () => verdecke("taste");

    const ereignisse: Array<[string, EventListener]> = [
      ["contextmenu", sperren],
      ["copy", sperren],
      ["cut", sperren],
      ["selectstart", sperren],
      ["dragstart", sperren],
    ];
    for (const [name, fn] of ereignisse) document.addEventListener(name, fn, true);
    window.addEventListener("keydown", taste, true);
    window.addEventListener("keyup", tasteHoch, true);
    window.addEventListener("blur", weg);
    window.addEventListener("focus", zurueck);
    window.addEventListener("beforeprint", druck);
    document.addEventListener("visibilitychange", sichtbarkeit);
    document.addEventListener("mouseout", mausRaus);
    document.addEventListener("mouseover", mausRein);
    return () => {
      for (const [name, fn] of ereignisse) document.removeEventListener(name, fn, true);
      window.removeEventListener("keydown", taste, true);
      window.removeEventListener("keyup", tasteHoch, true);
      window.removeEventListener("blur", weg);
      window.removeEventListener("focus", zurueck);
      window.removeEventListener("beforeprint", druck);
      document.removeEventListener("visibilitychange", sichtbarkeit);
      document.removeEventListener("mouseout", mausRaus);
      document.removeEventListener("mouseover", mausRein);
    };
  }, []);

  // Ein Klick auf die Abdeckung holt den Fokus zurueck.
  return [
    verdeckt,
    () => {
      window.focus();
      if (document.visibilityState === "visible") {
        grund.current = null;
        setVerdeckt(false);
      }
    },
  ];
}

/**
 * Offene Entwicklerwerkzeuge erkennen.
 *
 * Eine `debugger`-Anweisung tut nichts, solange die Werkzeuge zu sind. Sind
 * sie offen, haelt der Browser dort an, und die Pause ist messbar. Das gibt
 * keine Fehlalarme durch Zoom, Seitenleisten oder kleine Fenster; die alte
 * Erkennung ueber Fenstermasse sperrte genau daran zahlende Leser aus
 * (`docs/PROGRAMMIERPLAN.md`, Abschnitt 10). Wer die Werkzeuge offen hat,
 * bleibt dazu jede Sekunde im Haltepunkt haengen.
 */
export function useDevtoolsWache(aktiv: boolean): boolean {
  const [erkannt, setErkannt] = useState(false);
  useEffect(() => {
    if (!aktiv || erkannt) return;
    const id = window.setInterval(() => {
      const t0 = performance.now();
      // eslint-disable-next-line no-debugger
      debugger;
      if (performance.now() - t0 > 100) setErkannt(true);
    }, 1000);
    return () => window.clearInterval(id);
  }, [aktiv, erkannt]);
  return erkannt;
}
