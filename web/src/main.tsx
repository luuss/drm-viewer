import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import App from "./App";
import { installCanvasPoison } from "./reader/canvasPoison";

installCanvasPoison();

const convexUrl = import.meta.env.VITE_CONVEX_URL as string;
if (!convexUrl) {
  throw new Error("VITE_CONVEX_URL not set");
}
const convex = new ConvexReactClient(convexUrl);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConvexAuthProvider client={convex}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ConvexAuthProvider>
  </React.StrictMode>,
);
