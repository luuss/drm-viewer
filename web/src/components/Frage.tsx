/**
 * Nachfragen ohne Browserfenster.
 *
 * `window.confirm` blockiert den ganzen Faden, sieht auf jedem System anders
 * aus, erscheint am oberen Rand des Fensters statt bei der Schaltflaeche und
 * laesst sich nicht gestalten. Hier steht stattdessen ein eigener Dialog im
 * Fenster der Anwendung: mit Esc zu schliessen, mit der Eingabetaste zu
 * bestaetigen, und der Fokus liegt auf dem Knopf, der nichts kaputtmacht.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

export type FrageText = {
  titel: string;
  text?: string;
  /** Beschriftung des bestaetigenden Knopfes. */
  ja?: string;
  nein?: string;
  /** Rot einfaerben, wenn etwas verloren geht. */
  gefahr?: boolean;
};

type Offen = FrageText & { antwort: (ok: boolean) => void };

const Zusammenhang = createContext<(f: FrageText) => Promise<boolean>>(
  async () => false,
);

/** `const frage = useFrage(); if (await frage({...})) …` */
export function useFrage() {
  return useContext(Zusammenhang);
}

export function FrageHost({ children }: { children: React.ReactNode }) {
  const [offen, setOffen] = useState<Offen | null>(null);

  const frage = useCallback(
    (f: FrageText) =>
      new Promise<boolean>((antwort) => {
        setOffen({ ...f, antwort });
      }),
    [],
  );

  const schliessen = useCallback(
    (ok: boolean) => {
      setOffen((aktuell) => {
        aktuell?.antwort(ok);
        return null;
      });
    },
    [],
  );

  return (
    <Zusammenhang.Provider value={frage}>
      {children}
      {offen && <Dialog frage={offen} schliessen={schliessen} />}
    </Zusammenhang.Provider>
  );
}

function Dialog({
  frage,
  schliessen,
}: {
  frage: FrageText;
  schliessen: (ok: boolean) => void;
}) {
  const jaKnopf = useRef<HTMLButtonElement>(null);
  const neinKnopf = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Der Fokus liegt auf dem harmlosen Knopf: wer blind die Eingabetaste
    // drueckt, loescht nichts.
    (frage.gefahr ? neinKnopf : jaKnopf).current?.focus();
    const taste = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        schliessen(false);
      }
    };
    document.addEventListener("keydown", taste);
    return () => document.removeEventListener("keydown", taste);
  }, [frage, schliessen]);

  return (
    <div
      className="frage-schleier"
      onClick={(e) => {
        if (e.target === e.currentTarget) schliessen(false);
      }}
    >
      <div
        className="frage"
        role="dialog"
        aria-modal="true"
        aria-labelledby="frage-titel"
      >
        <h2 id="frage-titel">{frage.titel}</h2>
        {frage.text && <p>{frage.text}</p>}
        <div className="frage-knoepfe">
          <button ref={neinKnopf} className="btn secondary" onClick={() => schliessen(false)}>
            {frage.nein ?? "Abbrechen"}
          </button>
          <button
            ref={jaKnopf}
            className={frage.gefahr ? "btn danger" : "btn"}
            onClick={() => schliessen(true)}
          >
            {frage.ja ?? "Ja"}
          </button>
        </div>
      </div>
    </div>
  );
}
