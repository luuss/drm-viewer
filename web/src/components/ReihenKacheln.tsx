import { Link } from "react-router-dom";
import type { CSSProperties } from "react";
import Icon from "./Icon";
import { REIHENFOLGE, reiheVon, reihenSchluessel } from "../lib/reihen";

function rang(key: string) {
  const i = REIHENFOLGE.indexOf(key);
  return i < 0 ? REIHENFOLGE.length : i;
}

type Props = {
  /** Die Hefte der Seite; je Reihe entsteht eine Kachel. */
  hefte: { publicationName: string | null }[];
  /** Diese Reihe nicht zeigen (auf ihrer eigenen Seite). */
  ohne?: string;
  klein?: boolean;
};

/**
 * Die Reihen als Kacheln mit ihrem Schriftzug, wie die Kategorien im
 * Netzladen. Ein Tipp oeffnet die eigene Seite der Reihe.
 */
export default function ReihenKacheln({ hefte, ohne, klein }: Props) {
  const reihen = new Map<string, number>();
  for (const h of hefte) {
    if (!reiheVon(h.publicationName)) continue;
    const key = reihenSchluessel(h.publicationName);
    if (key !== ohne) reihen.set(key, (reihen.get(key) ?? 0) + 1);
  }
  if (reihen.size === 0) return null;

  return (
    <nav
      className={klein ? "reihen-kacheln klein" : "reihen-kacheln"}
      aria-label="Zeitschriften"
    >
      {[...reihen]
        .sort(([a], [b]) => rang(a) - rang(b))
        .map(([key, anzahl]) => {
          const reihe = reiheVon(
            hefte.find((h) => reihenSchluessel(h.publicationName) === key)
              ?.publicationName,
          )!;
          return (
            <Link
              key={key}
              to={`/zeitschrift/${key}`}
              className={`reihen-kachel reihe-${key}`}
              style={{ "--reihe": reihe.farbe } as CSSProperties}
            >
              <span className="reihen-logo">
                <img
                  src={reihe.hell}
                  alt={reihe.alt}
                  className={reihe.kasten ? "kasten" : undefined}
                />
              </span>
              <span className="reihen-fuss">
                <span className="reihen-anzahl">
                  {anzahl} {anzahl === 1 ? "Ausgabe" : "Ausgaben"}
                </span>
                <span className="reihen-weiter">
                  <span className="reihen-weiter-text">Zur Zeitschrift</span>
                  <Icon name="arrow-right" size={16} />
                </span>
              </span>
            </Link>
          );
        })}
    </nav>
  );
}
