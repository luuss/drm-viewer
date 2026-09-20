import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Entwicklungsbetrieb hinter einem Tunnel: fremde Host-Namen zulassen.
    allowedHosts: true,
    port: 5173,
  },
});
