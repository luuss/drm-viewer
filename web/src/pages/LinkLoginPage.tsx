import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useConvexAuth } from "convex/react";
import { ConvexError } from "convex/values";
import { useAuthActions } from "@convex-dev/auth/react";
import MagicLinkForm from "../components/MagicLinkForm";
import { AnmeldeRahmen } from "./LoginPage";
import { safeNext } from "../lib/anmeldung";

const GRUENDE: Record<string, string> = {
  benutzt: "Dieser Link wurde schon benutzt. Jeder Link meldet nur einmal an.",
  abgelaufen: "Dieser Link ist abgelaufen. Er gilt 15 Minuten.",
  unbekannt: "Dieser Link ist ungültig.",
};

function fehlerText(error: unknown): string {
  const grund =
    error instanceof ConvexError && typeof (error.data as any)?.grund === "string"
      ? (error.data as any).grund
      : "";
  return GRUENDE[grund] ?? "Die Anmeldung hat nicht geklappt.";
}

/**
 * Ziel des Links aus der Anmeldemail: `/anmelden?t=<token>&next=<pfad>`.
 * Meldet diesen Browser an und fuehrt weiter. Das Token verschwindet sofort
 * aus der Adresszeile, damit es nicht im Verlauf stehen bleibt.
 */
export default function LinkLoginPage() {
  const { signIn } = useAuthActions();
  const { isAuthenticated } = useConvexAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const [token] = useState(() => params.get("t"));
  const [fehler, setFehler] = useState<string | null>(null);
  const gestartet = useRef(false);

  useEffect(() => {
    if (!token || gestartet.current) return;
    gestartet.current = true;
    navigate(`/anmelden?next=${encodeURIComponent(next)}`, { replace: true });
    signIn("magic-link", { token })
      .then(() => navigate(next, { replace: true }))
      .catch((e) => setFehler(fehlerText(e)));
  }, [token, next, navigate, signIn]);

  useEffect(() => {
    // Nach dem Wechsel in den angemeldeten Zweig ist das Token schon weg.
    if (!token && isAuthenticated) navigate(next, { replace: true });
  }, [token, isAuthenticated, next, navigate]);

  if (token && !fehler) {
    return (
      <AnmeldeRahmen titel="Anmelden">
        <p className="hint" role="status">Anmeldung läuft …</p>
      </AnmeldeRahmen>
    );
  }

  return (
    <AnmeldeRahmen titel="Anmelden">
      {fehler && <div className="err">{fehler} Fordern Sie hier einen neuen an.</div>}
      <MagicLinkForm next={next} />
    </AnmeldeRahmen>
  );
}
