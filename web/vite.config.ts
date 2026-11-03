import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Marke der Anlage (src/lib/marke.ts). Titel, Symbol und Kopffarbe stehen im
// rohen HTML, damit Browser-Tab, Lesezeichen und Vorschau sofort stimmen.
const KOPF: Record<string, { titel: string; icon: string; theme: string }> = {
  weltkrieg: {
    titel: "Weltkrieg Digital",
    icon: '<link rel="icon" type="image/png" sizes="32x32" href="/img/wk/favicon-32.png" />\n    <link rel="icon" type="image/png" sizes="192x192" href="/img/wk/icon-192.png" />\n    <link rel="apple-touch-icon" href="/img/wk/apple-touch-icon.png" />',
    theme: "#222222",
  },
};

function marke(): Plugin {
  const kopf = KOPF[process.env.VITE_MARKE ?? ""];
  return {
    name: "marke",
    transformIndexHtml(html) {
      const id = process.env.VITE_MARKE || "lus";
      html = html.replace("<html lang=\"de\">", `<html lang="de" data-marke="${id}">`);
      if (!kopf) return html;
      return html
        .replace(/<title>.*<\/title>/, `<title>${kopf.titel}</title>`)
        .replace(/<link rel="icon"[^>]*\/>/, kopf.icon)
        .replace(/<meta name="theme-color" content="[^"]*"/, `<meta name="theme-color" content="${kopf.theme}"`);
    },
  };
}

export default defineConfig({
  plugins: [react(), marke()],
  server: {
    // Entwicklungsbetrieb hinter einem Tunnel: fremde Host-Namen zulassen.
    allowedHosts: true,
    port: 5173,
    proxy: {
      // Der Kacheldienst laeuft daneben auf 8000. Ueber diesen Umweg ist er
      // unter derselben Herkunft erreichbar, also genuegt ein Tunnel und es
      // gibt keine Herkunftssperre im Browser.
      "/tiles": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/tiles/, ""),
      },
    },
  },
});
