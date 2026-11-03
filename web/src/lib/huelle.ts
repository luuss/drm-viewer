/**
 * Service Worker fuer den Start ohne Verbindung (`public/sw.js`). Er merkt
 * sich nur die Huelle der Anwendung; die Hefte haelt der Reader selbst,
 * verschluesselt (`reader/puffer.ts`). Nur im Bau, nicht unter Vite.
 */
export function huelleAnmelden() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then(async () => {
        const reg = await navigator.serviceWorker.ready;
        // Was vor dem Worker geladen wurde (Skript, Stile, Schriften,
        // Logos), hat er nicht gesehen.
        const dateien = new Set<string>();
        for (const e of performance.getEntriesByType("resource")) {
          const url = new URL(e.name);
          if (url.origin === location.origin) dateien.add(url.pathname);
        }
        reg.active?.postMessage({ typ: "huelle", dateien: [...dateien] });
      })
      .catch(() => undefined);
  });
}
