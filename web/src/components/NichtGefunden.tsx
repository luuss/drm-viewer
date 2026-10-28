import { Link } from "react-router-dom";
import { Authenticated } from "convex/react";

/**
 * Eine Adresse, hinter der nichts steht: unbekanntes oder nicht
 * veroeffentlichtes Heft, kaputte Kennung im Leser, Tippfehler. Alle sehen
 * gleich aus, damit eine Adresse nicht verraet, ob es ein Heft im Entwurf
 * gibt. Frueher hing /issue/<unbekannt> bei "Laden...", /reader/<kaputt>
 * blieb leer, und der Rest leitete still in die Bibliothek um.
 */
export default function NichtGefunden({
  text = "Diese Seite gibt es nicht (mehr).",
}: {
  text?: string;
}) {
  return (
    <div className="centered nicht-gefunden">
      <h2>Nicht gefunden</h2>
      <p>{text}</p>
      <div className="row">
        <Link className="btn" to="/">
          Zum Kiosk
        </Link>
        <Authenticated>
          <Link className="btn secondary" to="/library">
            Zur Bibliothek
          </Link>
        </Authenticated>
      </div>
    </div>
  );
}
