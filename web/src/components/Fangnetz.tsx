import { Component, type ReactNode } from "react";
import { istKennungsfehler } from "../lib/kennung";
import NichtGefunden from "./NichtGefunden";

/**
 * Faengt den Fehler einer Abfrage mit einer Kennung, die es so nicht gibt
 * (etwa die Kennung eines Artikels in /reader/...), und zeigt "Nicht
 * gefunden" statt einer leeren Seite. Jeder andere Fehler bekommt einen
 * schlichten Hinweis mit "Neu laden".
 */
export default class Fangnetz extends Component<
  {
    children: ReactNode;
    /** Statt "Nicht gefunden" ohne Rahmen, etwa mit Kopf und Fuss der Seite. */
    ersatz?: ReactNode;
  },
  { fehler: unknown }
> {
  state = { fehler: null as unknown };

  static getDerivedStateFromError(fehler: unknown) {
    return { fehler };
  }

  render() {
    const { fehler } = this.state;
    if (fehler === null) return this.props.children;
    if (istKennungsfehler(fehler)) return this.props.ersatz ?? <NichtGefunden />;
    return (
      <div className="centered" role="alert">
        <p>Diese Seite konnte nicht geladen werden.</p>
        <button type="button" className="btn" onClick={() => window.location.reload()}>
          Neu laden
        </button>
      </div>
    );
  }
}
