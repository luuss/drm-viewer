import { Link, useSearchParams } from "react-router-dom";
import type { CSSProperties } from "react";
import Icon from "../components/Icon";
import {
  KIOSK_ANSICHTEN,
  alleNachNeuigkeit,
  kioskAnsicht,
  kioskReihen,
  neuesteJeReihe,
  type KioskHeft,
  type KioskReihe,
} from "./kioskWeltkrieg";
import { reiheVon } from "../lib/reihen";

/** Hefte, die eine Reihe im Kiosk neben ihrem neuesten zeigt. */
const KLEINE = 4;

function farbe(name: string | null): CSSProperties | undefined {
  const reihe = reiheVon(name);
  return reihe ? ({ "--reihe": reihe.farbe } as CSSProperties) : undefined;
}

function Umschlag({ heft }: { heft: KioskHeft }) {
  return heft.coverUrl ? (
    <img src={heft.coverUrl} alt={heft.displayTitle} loading="lazy" />
  ) : (
    <span className="cover-placeholder">{heft.displayTitle[0]}</span>
  );
}

/** Ein Heft als Umschlag mit Reihe, Titel und Nummer (Alle, Neueste). */
function HeftKarte({ heft }: { heft: KioskHeft }) {
  const reihe = reiheVon(heft.publicationName);
  return (
    <Link to={`/issue/${heft.slug}`} className="wk-heft" style={farbe(heft.publicationName)}>
      <span className="wk-heft-umschlag">
        <Umschlag heft={heft} />
      </span>
      <span className="wk-heft-text">
        <span className="wk-heft-reihe">{reihe?.name ?? heft.publicationName}</span>
        <span className="wk-heft-titel">{heft.displayTitle}</span>
        {heft.edition && <span className="wk-heft-nr">{heft.edition}</span>}
      </span>
    </Link>
  );
}

/** Eine Reihe als Kachel: Schriftzug, neuestes Heft gross, vier weitere daneben. */
function ReihenKarte({ gruppe }: { gruppe: KioskReihe<KioskHeft> }) {
  const [neuestes, ...weitere] = gruppe.hefte;
  const ziel = `/zeitschrift/${gruppe.key}`;
  const anzahl = gruppe.hefte.length;
  return (
    <section
      className={`wk-reihe reihe-${gruppe.key}`}
      style={gruppe.reihe ? ({ "--reihe": gruppe.reihe.farbe } as CSSProperties) : undefined}
      aria-label={gruppe.name}
    >
      <Link to={ziel} className="wk-reihe-kopf">
        {gruppe.reihe ? (
          <img src={gruppe.reihe.hell} alt={gruppe.reihe.alt} />
        ) : (
          <span className="wk-reihe-name">{gruppe.name}</span>
        )}
      </Link>
      <div className={weitere.length ? "wk-reihe-buehne" : "wk-reihe-buehne allein"}>
        <Link to={`/issue/${neuestes.slug}`} className="wk-reihe-gross">
          <Umschlag heft={neuestes} />
        </Link>
        {weitere.length > 0 && (
          <div className="wk-reihe-klein">
            {weitere.slice(0, KLEINE).map((h) => (
              <Link key={h._id} to={`/issue/${h.slug}`} title={h.displayTitle}>
                <Umschlag heft={h} />
              </Link>
            ))}
          </div>
        )}
      </div>
      <Link to={`/issue/${neuestes.slug}`} className="wk-reihe-neu">
        <span className="wk-reihe-neu-titel">{neuestes.displayTitle}</span>
        {neuestes.edition && <span className="wk-reihe-neu-nr">{neuestes.edition}</span>}
      </Link>
      <Link to={ziel} className="wk-reihe-fuss">
        <span className="wk-reihe-anzahl">
          {anzahl} {anzahl === 1 ? "Ausgabe" : "Ausgaben"}
        </span>
        <span className="wk-reihe-weiter">
          Zur Zeitschrift <Icon name="arrow-right" size={16} />
        </span>
      </Link>
    </section>
  );
}

/**
 * Kiosk von digital.weltkrieg-online.de. Anders als bei Lesen und Schenken
 * stehen die Hefte gleich hier, nicht erst hinter den Kacheln der Reihen.
 * Oben rechts drei Ansichten: Alle (jedes Heft, neueste zuerst), Kategorien
 * (je Reihe eine Kachel, drei nebeneinander) und Neueste (das neueste Heft
 * jeder Reihe). Die Wahl steht in der Adresse (`?ansicht=`), damit "Zurück"
 * aus einem Heft wieder dort ankommt.
 */
export default function KioskWeltkrieg({ hefte }: { hefte: KioskHeft[] }) {
  const [adresse, setAdresse] = useSearchParams();
  const ansicht = kioskAnsicht(adresse.get("ansicht"));
  const waehle = (a: string) => {
    const neu = new URLSearchParams(adresse);
    if (a === "kategorien") neu.delete("ansicht");
    else neu.set("ansicht", a);
    setAdresse(neu, { replace: true });
  };

  return (
    <div className="wk-kiosk">
      {/* Ohne Ueberschrift und Erklaerung (Anweisung 05.11.2026): nur die
          Marke und der Umschalter. */}
      <div className="page-head kiosk-kopf wk-kiosk-kopf">
        <span className="kicker">Kiosk</span>
        <div className="segment" role="group" aria-label="Ansicht">
          {KIOSK_ANSICHTEN.map(([wert, text]) => (
            <button
              key={wert}
              type="button"
              aria-pressed={ansicht === wert}
              onClick={() => waehle(wert)}
            >
              {text}
            </button>
          ))}
        </div>
      </div>

      {hefte.length === 0 ? (
        <div className="empty">
          <p>Noch keine Ausgabe veröffentlicht.</p>
        </div>
      ) : ansicht === "kategorien" ? (
        <div className="wk-reihen">
          {kioskReihen(hefte).map((g) => (
            <ReihenKarte key={g.key} gruppe={g} />
          ))}
        </div>
      ) : (
        <div className="wk-hefte">
          {(ansicht === "alle" ? alleNachNeuigkeit(hefte) : neuesteJeReihe(hefte)).map((h) => (
            <HeftKarte key={h._id} heft={h} />
          ))}
        </div>
      )}
    </div>
  );
}
