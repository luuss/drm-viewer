import { Link, useLocation } from "react-router-dom";
import { useGespeicherteAusgabe, useOhneVerbindung } from "../reader/offline";

/**
 * Ohne Verbindung laedt ausser dem gespeicherten Heft nichts (Bibliothek,
 * Kiosk, Anmeldung). Dann steht hier der Weg dorthin.
 */
export default function OfflineHinweis() {
  const ohne = useOhneVerbindung();
  const ausgabe = useGespeicherteAusgabe();
  const { pathname } = useLocation();
  if (!ohne || !ausgabe || pathname === `/reader/${ausgabe.issueId}`) return null;
  return (
    <p className="offline-hinweis" role="status">
      Keine Verbindung.{" "}
      <Link to={`/reader/${ausgabe.issueId}`}>{ausgabe.title} weiterlesen</Link>
    </p>
  );
}
