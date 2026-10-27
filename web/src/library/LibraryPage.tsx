import { Link } from "react-router-dom";
import { useQuery } from "convex/react";
import { api } from "../lib/api";
import Icon from "../components/Icon";
import ShopHinweis from "../components/ShopHinweis";
import { REIHENFOLGE, reiheVon, reihenSchluessel } from "../lib/reihen";

const MONATE = [
  "jan", "feb", "mär", "apr", "mai", "jun", "jul", "aug", "sep", "okt", "nov", "dez",
];

type Heftdaten = {
  issueNumber: string | null;
  edition: string | null;
  publicationDate?: number | null;
};

/**
 * Jahrgang und Rang eines Heftes im Jahr. Viele Hefte haben kein
 * Erscheinungsdatum; dann gelten "12/2025" in der Nummer oder Monat und Jahr
 * in der Unterzeile ("Ausgabe März/April 2026"). Laufende Nummern (DMZ 170)
 * ordnen innerhalb des Jahres.
 */
function einordnen(h: Heftdaten): { jahr: number | null; rang: number } {
  const nr = h.issueNumber ?? "";
  // Nicht der Titel: "Mscha 1943" ist kein Jahrgang.
  const text = h.edition ?? "";
  const datum = h.publicationDate ? new Date(h.publicationDate) : null;
  const schraeg = nr.match(/^(\d{1,2})\s*\/\s*((?:19|20)\d{2})$/);
  const jahrImText = `${nr} ${text}`.match(/\b((?:19|20)\d{2})\b/);
  const jahr = schraeg
    ? Number(schraeg[2])
    : jahrImText
      ? Number(jahrImText[1])
      : datum
        ? datum.getFullYear()
        : null;
  const klein = text.toLowerCase();
  const monatImText = MONATE.findIndex((m) => klein.includes(m));
  const monat = schraeg
    ? Number(schraeg[1])
    : monatImText >= 0
      ? monatImText + 1
      : datum
        ? datum.getMonth() + 1
        : 0;
  const laufend = /^\d+$/.test(nr) ? Number(nr) : 0;
  return { jahr, rang: monat * 100000 + laufend };
}

function rangDerReihe(key: string) {
  const i = REIHENFOLGE.indexOf(key);
  return i < 0 ? REIHENFOLGE.length : i;
}

/**
 * Nur Ausgaben, auf die der angemeldete Leser Zugriff hat, ohne Umweg ueber
 * Kacheln: je Zeitschrift eine Ueberschrift, darunter die Jahrgaenge, neuester
 * zuerst. Jeder Jahrgang zeigt, wie viele seiner im Kiosk veroeffentlichten
 * Hefte der Leser hat.
 */
export default function LibraryPage() {
  const issues = useQuery(api.issues.myLibrary, {});
  const kiosk = useQuery(api.issues.listPublished, {});
  if (issues === undefined || kiosk === undefined) {
    return <div className="centered">Laden...</div>;
  }

  if (issues.length === 0) {
    return (
      <div className="page">
        <div className="page-head">
          <h2>Meine Ausgaben</h2>
          <p className="hint">Freigeschaltete Hefte, dauerhaft lesbar.</p>
        </div>
        <div className="empty">
          <p>Noch keine Ausgabe freigeschaltet.</p>
          <ShopHinweis />
          <Link className="btn" to="/">
            <Icon name="kiosk" />
            Zum Kiosk
          </Link>
        </div>
      </div>
    );
  }

  const datumVon = new Map(kiosk.map((k) => [k._id, k.publicationDate]));
  // Im Kiosk veroeffentlichte Hefte je Reihe und Jahrgang.
  const imKiosk = new Map<string, number>();
  for (const k of kiosk) {
    const { jahr } = einordnen(k);
    const key = `${reihenSchluessel(k.publicationName)}|${jahr}`;
    imKiosk.set(key, (imKiosk.get(key) ?? 0) + 1);
  }

  const reihen = new Map<
    string,
    { name: string; jahrgaenge: Map<number | null, (typeof issues[number] & { rang: number })[]> }
  >();
  for (const i of issues) {
    const key = reihenSchluessel(i.publicationName);
    const { jahr, rang } = einordnen({ ...i, publicationDate: datumVon.get(i._id) });
    if (!reihen.has(key)) {
      reihen.set(key, {
        name: reiheVon(i.publicationName)?.name ?? i.publicationName ?? i.displayTitle,
        jahrgaenge: new Map(),
      });
    }
    const jahrgaenge = reihen.get(key)!.jahrgaenge;
    if (!jahrgaenge.has(jahr)) jahrgaenge.set(jahr, []);
    jahrgaenge.get(jahr)!.push({ ...i, rang });
  }

  return (
    <div className="page">
      <div className="page-head">
        <h2>Meine Ausgaben</h2>
        <p className="hint">Freigeschaltete Hefte, dauerhaft lesbar.</p>
      </div>
      {[...reihen]
        .sort(([a, ra], [b, rb]) => rangDerReihe(a) - rangDerReihe(b) || ra.name.localeCompare(rb.name))
        .map(([key, reihe]) => (
          <section key={key} className="bibliothek-reihe">
            <h3>{reihe.name}</h3>
            {[...reihe.jahrgaenge]
              .sort(([a], [b]) => (b ?? 0) - (a ?? 0))
              .map(([jahr, hefte]) => {
                const gesamt = Math.max(imKiosk.get(`${key}|${jahr}`) ?? 0, hefte.length);
                return (
                  <div key={jahr ?? "ohne"} className="bibliothek-jahrgang">
                    {jahr !== null && (
                      <div className="jahrgang-kopf">
                        <h4>Jahrgang {jahr}</h4>
                        <div
                          className="jahrgang-balken"
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={gesamt}
                          aria-valuenow={hefte.length}
                          aria-label={`Jahrgang ${jahr}: ${hefte.length} von ${gesamt}`}
                        >
                          <span style={{ width: `${(hefte.length / gesamt) * 100}%` }} />
                        </div>
                        <span className="jahrgang-zahl">
                          {hefte.length} von {gesamt}
                        </span>
                      </div>
                    )}
                    <div className="issue-grid">
                      {hefte
                        .sort((a, b) => b.rang - a.rang)
                        .map((i) => (
                          <Link key={i._id} to={`/reader/${i._id}`} className="issue-card">
                            <div className="issue-cover-preview">
                              {i.coverUrl ? (
                                <img src={i.coverUrl} alt={i.displayTitle} loading="lazy" />
                              ) : (
                                <div className="cover-placeholder">{i.displayTitle[0]}</div>
                              )}
                            </div>
                            <div className="issue-card-body">
                              <div className="title">{i.displayTitle}</div>
                              <div className="meta">
                                {i.edition ? `${i.edition} · ` : ""}
                                {i.pageCount} Seiten
                              </div>
                              <div className="cta">
                                {i.progress ? (
                                  <>
                                    <span className="go">Weiterlesen <Icon name="arrow-right" /></span>
                                    <span className="where">
                                      {i.progress.mode === "article"
                                        ? "Artikel"
                                        : `Seite ${i.progress.pageIndex + 1} von ${i.pageCount}`}
                                    </span>
                                  </>
                                ) : (
                                  <span className="go">Lesen <Icon name="arrow-right" /></span>
                                )}
                              </div>
                            </div>
                          </Link>
                        ))}
                    </div>
                  </div>
                );
              })}
          </section>
        ))}
    </div>
  );
}
