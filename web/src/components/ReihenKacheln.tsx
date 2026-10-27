import { Link } from "react-router-dom";
import type { CSSProperties } from "react";
import Icon from "./Icon";
import { REIHENFOLGE, reiheVon, reihenSchluessel } from "../lib/reihen";

function rang(key: string) {
  const i = REIHENFOLGE.indexOf(key);
  return i < 0 ? REIHENFOLGE.length : i;
}

type Props = {
  /** Die Hefte der Seite, neueste zuerst; je Reihe entsteht eine Kachel. */
  hefte: { publicationName: string | null; coverUrl?: string | null }[];
  /** Diese Reihe nicht zeigen (auf ihrer eigenen Seite). */
  ohne?: string;
  klein?: boolean;
};

/**
 * Die Reihen als Kacheln: links der Schriftzug, rechts die neuesten Umschlaege,
 * die wie im Zeitschriftenregal von unten ins Bild ragen. Die Flaeche dahinter
 * ist zart in der Hausfarbe getoent. Ein Tipp oeffnet die eigene Seite der Reihe.
 */
export default function ReihenKacheln({ hefte, ohne, klein }: Props) {
  const reihen = new Map<string, { anzahl: number; umschlaege: string[] }>();
  for (const h of hefte) {
    if (!reiheVon(h.publicationName)) continue;
    const key = reihenSchluessel(h.publicationName);
    if (key === ohne) continue;
    const r = reihen.get(key) ?? { anzahl: 0, umschlaege: [] };
    r.anzahl += 1;
    if (h.coverUrl && r.umschlaege.length < 2) r.umschlaege.push(h.coverUrl);
    reihen.set(key, r);
  }
  if (reihen.size === 0) return null;

  return (
    <nav
      className={klein ? "reihen-kacheln klein" : "reihen-kacheln"}
      aria-label="Zeitschriften"
    >
      {[...reihen]
        .sort(([a], [b]) => rang(a) - rang(b))
        .map(([key, { anzahl, umschlaege }]) => {
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
              <span className="reihen-buehne">
                <span className="reihen-logo">
                  <img
                    src={reihe.hell}
                    alt={reihe.alt}
                    className={reihe.kasten ? "kasten" : undefined}
                  />
                </span>
                {umschlaege.length > 0 && (
                  <span className="reihen-umschlaege" aria-hidden="true">
                    {/* Das neueste Heft vorn, das vorige schraeg dahinter. */}
                    {[...umschlaege].reverse().map((url, i, alle) => (
                      <img
                        key={url}
                        src={url}
                        alt=""
                        loading="lazy"
                        className={i === alle.length - 1 ? "vorn" : "hinten"}
                      />
                    ))}
                  </span>
                )}
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
