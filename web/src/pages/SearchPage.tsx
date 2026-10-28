import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useConvexAuth, useQuery } from "convex/react";
import { api, formatEuro } from "../lib/api";
import Icon from "../components/Icon";
import { heraus, hinein, useWarenkorb } from "../lib/warenkorb";
import "./search.css";

/** Ab so vielen Zeichen sucht das Backend. */
const MIN_ZEICHEN = 3;
/** Pause nach dem letzten Tastendruck, bevor gesucht wird. */
const ENTPRELLUNG_MS = 220;
/** Treffer je Abruf in den eigenen Heften; "Weitere Treffer" holt so viele dazu. */
const SEITE = 25;
const ZULETZT_KEY = "suche-zuletzt";
const ZULETZT_MAX = 6;

function zuletztLesen(): string[] {
  try {
    const roh = window.localStorage.getItem(ZULETZT_KEY);
    const liste = roh ? JSON.parse(roh) : [];
    return Array.isArray(liste) ? liste.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function zuletztMerken(begriff: string): string[] {
  const liste = [
    begriff,
    ...zuletztLesen().filter((s) => s.toLowerCase() !== begriff.toLowerCase()),
  ].slice(0, ZULETZT_MAX);
  try {
    window.localStorage.setItem(ZULETZT_KEY, JSON.stringify(liste));
  } catch {
    // Ohne Speicher gibt es eben keine Liste der letzten Suchen.
  }
  return liste;
}

/** Sprung in den Leser, zum Absatz der Fundstelle, wenn es einen gibt. */
function leserLink(r: { issueId: string; _id: string; stelle: number | null }) {
  return `/reader/${r.issueId}?article=${r._id}${r.stelle !== null ? `&stelle=${r.stelle}` : ""}`;
}

/**
 * Suche ueber die freigeschalteten Hefte (Volltext) und die Verzeichnisse
 * aller Hefte im Kiosk. Gesucht wird schon beim Tippen, kurz entprellt; die
 * Treffer stehen je Heft beisammen, mit Umschlag, Reihe und Seite. Der
 * Begriff steht in der Adresse (`?q=`): Zurueck aus dem Leser und ein
 * geteilter Link zeigen dieselbe Suche.
 */
export default function SearchPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const [term, setTerm] = useState(q);
  const [begriff, setBegriff] = useState(q.trim());
  const [limit, setLimit] = useState(SEITE);
  const [zuletzt, setZuletzt] = useState<string[]>(zuletztLesen);
  const eingabe = useRef<HTMLInputElement>(null);
  const { isAuthenticated } = useConvexAuth();
  const auswahl = useWarenkorb();

  useEffect(() => {
    const t = window.setTimeout(() => setBegriff(term.trim()), ENTPRELLUNG_MS);
    return () => window.clearTimeout(t);
  }, [term]);

  // Begriff in die Adresse, ohne fuer jeden Tastendruck einen Eintrag im
  // Verlauf. Aendert sich die Adresse von aussen (Kopfzeile "Suche"), folgt
  // das Feld.
  const geschrieben = useRef(q);
  useEffect(() => {
    if (q === geschrieben.current) return;
    geschrieben.current = q;
    setTerm(q);
    setBegriff(q.trim());
  }, [q]);
  useEffect(() => {
    const ziel = begriff.length >= MIN_ZEICHEN ? begriff : "";
    if (ziel === geschrieben.current) return;
    geschrieben.current = ziel;
    setParams(ziel ? { q: ziel } : {}, { replace: true });
  }, [begriff, setParams]);

  // Ein neuer Begriff beginnt wieder mit der ersten Seite Treffer.
  useEffect(() => setLimit(SEITE), [begriff]);

  const active = begriff.length >= MIN_ZEICHEN;
  // Volltext nur in freigeschalteten Heften; aus allen anderen die Verzeichnisse.
  const abgefragt = useQuery(
    api.articles.search,
    active && isAuthenticated ? { term: begriff, limit } : "skip",
  );
  // Laedt "Weitere Treffer", bleiben die bisherigen stehen, statt dass die
  // Liste kurz verschwindet.
  const vorher = useRef<{ begriff: string; ergebnis: NonNullable<typeof abgefragt> } | null>(null);
  if (abgefragt) vorher.current = { begriff, ergebnis: abgefragt };
  const results =
    abgefragt ?? (vorher.current?.begriff === begriff ? vorher.current.ergebnis : undefined);
  const mehrLaedt = abgefragt === undefined && results !== undefined;
  const kiosk = useQuery(api.tocPreview.searchCatalog, active ? { term: begriff } : "skip");
  const bibliothek = useQuery(api.issues.myLibrary, isAuthenticated ? {} : "skip");

  const eigene = isAuthenticated ? results?.treffer : [];
  // Stiess die Suche an ihre Tiefe, kann es mehr geben, als gezaehlt sind.
  const unvollstaendig = isAuthenticated && results?.vollstaendig === false;
  const laeuft = active && (eigene === undefined || kiosk === undefined);
  // Waehrend getippt wird, bleiben die letzten Treffer stehen statt zu flackern.
  const tipptNoch = term.trim() !== begriff;

  // Eigene Treffer je Heft, mit Umschlag und Reihe aus der Bibliothek.
  const gruppen = useMemo(() => {
    const hefte = new Map((bibliothek ?? []).map((h) => [h._id as string, h]));
    const out: {
      issueId: string;
      titel: string;
      reihe: string | null;
      cover: string | null;
      treffer: NonNullable<typeof eigene>;
    }[] = [];
    for (const r of eigene ?? []) {
      let g = out.find((x) => x.issueId === (r.issueId as string));
      if (!g) {
        const heft = hefte.get(r.issueId as string);
        g = {
          issueId: r.issueId as string,
          titel: r.issueTitle,
          reihe: heft?.publicationName ?? null,
          cover: heft?.coverUrl ?? null,
          treffer: [],
        };
        out.push(g);
      }
      g.treffer.push(r);
    }
    return out;
  }, [eigene, bibliothek]);

  const eigeneAnzahl = isAuthenticated ? (results?.gesamt ?? 0) : 0;
  const anzahl = eigeneAnzahl + (kiosk ?? []).reduce((n, h) => n + h.entries.length + h.more, 0);
  const ersterLink = gruppen[0]?.treffer[0]
    ? leserLink(gruppen[0].treffer[0])
    : kiosk?.[0]
      ? `/issue/${kiosk[0].slug}?bild=inhalt`
      : null;

  const merken = () => {
    if (begriff.length >= MIN_ZEICHEN) setZuletzt(zuletztMerken(begriff));
  };

  const suchen = (wort: string) => {
    setTerm(wort);
    setBegriff(wort);
    eingabe.current?.focus();
  };

  return (
    <div className="page suche">
      <div className="suche-kopf">
        <h2>Suche</h2>
        <form
          className="suche-feld"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ersterLink || laeuft || tipptNoch) return;
            merken();
            navigate(ersterLink);
          }}
        >
          <Icon name="search" size={22} />
          <input
            ref={eingabe}
            type="search"
            aria-label="Suchbegriff"
            placeholder="Thema, Name, Ort …"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setTerm("");
                setBegriff("");
              }
            }}
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
          {term && (
            <button
              type="button"
              className="suche-leeren"
              aria-label="Suchbegriff löschen"
              onClick={() => suchen("")}
            >
              <Icon name="close" size={18} />
            </button>
          )}
        </form>
        <p className="suche-umfang">
          {isAuthenticated
            ? "Volltext aller Hefte. Bei Ihren Ausgaben mit Textstelle, bei allen anderen mit Artikel und Seite."
            : "Volltext aller Hefte im Kiosk, mit Artikel und Seite."}
        </p>
      </div>

      {/* Eine Statuszeile an fester Stelle: zu kurz, laeuft, Trefferzahl. */}
      <div className="suche-status" aria-live="polite">
        {term.trim().length > 0 && term.trim().length < MIN_ZEICHEN && (
          <span>Noch {MIN_ZEICHEN - term.trim().length} Zeichen …</span>
        )}
        {active && (laeuft || tipptNoch) && <span className="suche-laeuft">Suche läuft</span>}
        {active && !laeuft && !tipptNoch && anzahl > 0 && (
          <span>
            {unvollstaendig && "Mehr als "}
            <strong>{anzahl}</strong> Treffer zu „{begriff}“
            {ersterLink && <span className="suche-tipp"> · Enter öffnet den ersten</span>}
          </span>
        )}
      </div>

      {!active && term.trim().length === 0 && (
        <div className="suche-leer">
          {zuletzt.length > 0 ? (
            <>
              <h3>Zuletzt gesucht</h3>
              <div className="suche-chips">
                {zuletzt.map((w) => (
                  <button key={w} type="button" className="suche-chip" onClick={() => suchen(w)}>
                    {w}
                  </button>
                ))}
                <button
                  type="button"
                  className="suche-chip leise"
                  onClick={() => {
                    try {
                      window.localStorage.removeItem(ZULETZT_KEY);
                    } catch {
                      // nichts zu tun
                    }
                    setZuletzt([]);
                  }}
                >
                  Liste leeren
                </button>
              </div>
            </>
          ) : (
            <p>Tippen Sie einen Begriff ein – die Treffer erscheinen schon beim Schreiben.</p>
          )}
        </div>
      )}

      {active && !laeuft && !tipptNoch && anzahl === 0 && (
        <div className="suche-leer">
          <h3>Nichts gefunden zu „{begriff}“</h3>
          <p>Ein kürzeres Wort oder ein Namensteil findet oft mehr.</p>
        </div>
      )}

      {active && gruppen.length > 0 && (
        <section className="suche-block">
          <h3>
            In Ihren Ausgaben{" "}
            <span className="zahl">
              {unvollstaendig && "mehr als "}
              {eigeneAnzahl}
            </span>
          </h3>
          {gruppen.map((g) => (
            <article key={g.issueId} className="suche-heft">
              <Link to={`/reader/${g.issueId}`} className="suche-cover" tabIndex={-1}>
                {g.cover ? (
                  <img src={g.cover} alt="" loading="lazy" />
                ) : (
                  <span className="cover-placeholder">{g.titel[0]}</span>
                )}
              </Link>
              <div className="suche-heft-body">
                <div className="suche-heft-kopf">
                  {g.reihe && g.reihe !== g.titel && <span className="reihe">{g.reihe}</span>}
                  <span className="heft">{g.titel}</span>
                </div>
                <ul className="suche-treffer">
                  {g.treffer.map((r) => (
                    <li key={r._id}>
                      <Link to={leserLink(r)} onClick={merken}>
                        <span className="titel">
                          <Markiert text={r.title} begriff={begriff} />
                        </span>
                        <span className="seite">S. {r.page}</span>
                        <span className="ausschnitt">
                          <Markiert text={r.snippet} begriff={begriff} />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            </article>
          ))}
          {(eigene?.length ?? 0) < eigeneAnzahl && (
            <div className="suche-mehr">
              <button
                type="button"
                className="btn secondary small"
                disabled={mehrLaedt}
                aria-busy={mehrLaedt}
                onClick={() => setLimit((n) => n + SEITE)}
              >
                Weitere Treffer
              </button>
              <span className="hint">
                {eigene?.length} von {unvollstaendig && "mehr als "}
                {eigeneAnzahl}
              </span>
            </div>
          )}
        </section>
      )}

      {active && kiosk && kiosk.length > 0 && (
        <section className="suche-block">
          <h3>
            Im Kiosk <span className="zahl">{kiosk.length} {kiosk.length === 1 ? "Heft" : "Hefte"}</span>
          </h3>
          {kiosk.map((h) => (
            <article key={h._id} className="suche-heft">
              <Link to={`/issue/${h.slug}?bild=inhalt`} className="suche-cover" tabIndex={-1}>
                {h.coverUrl ? (
                  <img src={h.coverUrl} alt="" loading="lazy" />
                ) : (
                  <span className="cover-placeholder">{h.displayTitle[0]}</span>
                )}
              </Link>
              <div className="suche-heft-body">
                <Link
                  to={`/issue/${h.slug}?bild=inhalt`}
                  className="suche-heft-kopf"
                  onClick={merken}
                >
                  {h.publicationName && h.publicationName !== h.displayTitle && (
                    <span className="reihe">{h.publicationName}</span>
                  )}
                  <span className="heft">
                    {h.displayTitle}
                    {h.edition && <span className="ausgabe"> · {h.edition}</span>}
                  </span>
                </Link>
                <ul className="suche-treffer verzeichnis">
                  {h.entries.map((e) => (
                    <li key={e._id}>
                      <Link to={`/issue/${h.slug}?bild=inhalt`} onClick={merken}>
                        <span className="titel">
                          {e.section && <span className="rubrik">{e.section}</span>}
                          <Markiert text={e.label} begriff={begriff} />
                        </span>
                        {e.page && <span className="seite">S. {e.page}</span>}
                        {e.subtitle && (
                          <span className="ausschnitt">
                            <Markiert text={e.subtitle} begriff={begriff} />
                          </span>
                        )}
                        {/* Fundstelle im Artikeltext: der Text selbst bleibt
                            bis zum Kauf verborgen. */}
                        {e.imText && <span className="im-text">Im Artikeltext gefunden</span>}
                      </Link>
                    </li>
                  ))}
                  {h.more > 0 && <li className="mehr">und {h.more} weitere im Heft</li>}
                </ul>
                <div className="suche-kauf">
                  <span className="preis">{formatEuro(h.priceAmountCents)}</span>
                  {h.shopSku && (
                    <button
                      type="button"
                      className={`btn secondary small${auswahl.includes(h._id) ? " on" : ""}`}
                      aria-pressed={auswahl.includes(h._id)}
                      onClick={() => (auswahl.includes(h._id) ? heraus(h._id) : hinein(h._id))}
                    >
                      <Icon name="cart" size={15} />
                      {auswahl.includes(h._id) ? "Im Warenkorb" : "In den Warenkorb"}
                    </button>
                  )}
                </div>
              </div>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}

/** Hebt die Woerter des Suchbegriffs hervor, ohne Gross- und Kleinschreibung. */
function Markiert({ text, begriff }: { text: string; begriff: string }) {
  const woerter = begriff
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (woerter.length === 0) return <>{text}</>;
  const teile = text.split(new RegExp(`(${woerter.join("|")})`, "gi"));
  return (
    <>
      {teile.map((t, i) =>
        i % 2 === 1 ? <mark key={i}>{t}</mark> : <Fragment key={i}>{t}</Fragment>,
      )}
    </>
  );
}
