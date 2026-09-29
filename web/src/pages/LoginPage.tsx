import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import MagicLinkForm from "../components/MagicLinkForm";
import { ABGEMELDET_KEY, safeNext } from "../lib/anmeldung";

export default function LoginPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const [abgemeldet, setAbgemeldet] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(ABGEMELDET_KEY)) {
      localStorage.removeItem(ABGEMELDET_KEY);
      setAbgemeldet(true);
    }
  }, []);

  return (
    <AnmeldeRahmen titel="Anmelden">
      {abgemeldet && (
        <div className="err" role="status">
          Dieser Browser wurde abgemeldet. Ein Konto kann in höchstens zwei Browsern zugleich
          angemeldet sein; die älteste Anmeldung endet, sobald eine dritte dazukommt.
        </div>
      )}
      <MagicLinkForm next={next} />
    </AnmeldeRahmen>
  );
}

/** Kasten mit Marke, Titel und Fusszeile; auch fuer /anmelden. */
export function AnmeldeRahmen({ titel, children }: { titel: string; children: React.ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-box">
        <div className="auth-brand">
          <img src="/img/lesen-und-schenken.png" alt="Lesen und Schenken" className="brand-logo" />
          <span className="brand-sub">Digital</span>
        </div>
        <div className="titles">
          <h1>{titel}</h1>
          <p className="subtitle">
            Die Zeitschriften von Lesen &amp; Schenken digital lesen — auf jedem Gerät.
          </p>
        </div>
        {children}
        <p className="legal-line">
          <Link to="/">Ohne Anmeldung: Hefte im Kiosk ansehen</Link>
        </p>
        <p className="legal-line">
          <Link to="/impressum">Impressum</Link> ·{" "}
          <Link to="/datenschutz">Datenschutz</Link> ·{" "}
          <Link to="/agb">AGB</Link>
        </p>
      </div>
    </div>
  );
}
