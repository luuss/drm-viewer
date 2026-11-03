import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { FrageHost } from "./components/Frage";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import App from "./App";
import { MARKE } from "./lib/marke";
import { huelleAnmelden } from "./lib/huelle";

// Fallback, falls die Marke nur aus einer Vite-.env kommt (vite.config.ts setzt sie sonst schon ins HTML).
document.documentElement.dataset.marke = MARKE.id;


const convexUrl = import.meta.env.VITE_CONVEX_URL as string;
if (!convexUrl) {
  throw new Error("VITE_CONVEX_URL not set");
}
const convex = new ConvexReactClient(convexUrl);
// Ohne Verbindung startet die Anwendung aus dem Service Worker.
huelleAnmelden();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConvexAuthProvider client={convex}>
      <BrowserRouter>
        <FrageHost>
          <App />
        </FrageHost>
      </BrowserRouter>
    </ConvexAuthProvider>
  </React.StrictMode>,
);
