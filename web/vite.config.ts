import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
