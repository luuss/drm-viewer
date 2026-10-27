import { Link } from "react-router-dom";
import { useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../lib/api";
import Icon from "../components/Icon";
import ShopHinweis from "../components/ShopHinweis";
import { REIHENFOLGE, reiheVon, reihenSchluessel, type Reihe } from "../lib/reihen";

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

type Ansicht = "detail" | "kompakt" | "liste";
const ANSICHTEN: [Ansicht, string][] = [
  ["kompakt", "Kompakt"],
  ["detail", "Detail"],
  ["liste", "Liste"],
];
const ANSICHT_KEY = "bibliothek-ansicht";

function gemerkteAnsicht(): Ansicht {
  try {
    const wert = window.localStorage.getItem(ANSICHT_KEY);
    return ANSICHTEN.some(([a]) => a === wert) ? (wert as Ansicht) : "kompakt";
  } catch {
    return "kompakt";
  }
}

function rangDerReihe(key: string) {
  const i = REIHENFOLGE.indexOf(key);
  return i < 0 ? REIHENFOLGE.length : i;
}

/**
 * Nur Ausgaben, auf die der angemeldete Leser Zugriff hat, ohne Umweg ueber
 * Kacheln: je Zeitschrift eine Ueberschrift, darunter die Jahrgaenge, neuester
 * zuerst. Jeder Jahrgang zeigt, wie viele seiner im Kiosk veroeffentlichten
 * Hefte der Leser hat. Drei Ansichten: Kompakt (Standard; kleine Umschlaege,
 * Zeitschriften nur als Trenner), Detail (Karten) und Liste.
 */
export default function LibraryPage() {
  const issues = useQuery(api.issues.myLibrary, {});
  const kiosk = useQuery(api.issues.listPublished, {});
  const [ansicht, setAnsicht] = useState<Ansicht>(gemerkteAnsicht);
  const waehle = (a: Ansicht) => {
    setAnsicht(a);
    try {
      window.localStorage.setItem(ANSICHT_KEY, a);
    } catch {
      // Ohne Speicher gilt die Wahl nur bis zum Neuladen.
    }
  };
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

  type Heft = (typeof issues)[number] & { rang: number };
  const reihen = new Map<
    string,
    { name: string; reihe: Reihe | null; jahrgaenge: Map<number | null, Heft[]> }
  >();
  for (const i of issues) {
    const key = reihenSchluessel(i.publicationName);
    const { jahr, rang } = einordnen({ ...i, publicationDate: datumVon.get(i._id) });
    if (!reihen.has(key)) {
      const reihe = reiheVon(i.publicationName);
      reihen.set(key, {
        name: reihe?.name ?? i.publicationName ?? i.displayTitle,
        reihe,
        jahrgaenge: new Map(),
      });
    }
    const jahrgaenge = reihen.get(key)!.jahrgaenge;
    if (!jahrgaenge.has(jahr)) jahrgaenge.set(jahr, []);
    jahrgaenge.get(jahr)!.push({ ...i, rang });
  }
  // Reihen wie im Kiosk, Jahrgaenge und Hefte neueste zuerst.
  const gruppen = [...reihen]
    .sort(([a, ra], [b, rb]) => rangDerReihe(a) - rangDerReihe(b) || ra.name.localeCompare(rb.name))
    .map(([key, r]) => ({
      key,
      name: r.name,
      reihe: r.reihe,
      jahrgaenge: [...r.jahrgaenge]
        .sort(([a], [b]) => (b ?? 0) - (a ?? 0))
        .map(([jahr, hefte]) => ({
          jahr,
          gesamt: Math.max(imKiosk.get(`${key}|${jahr}`) ?? 0, hefte.length),
          hefte: hefte.sort((a, b) => b.rang - a.rang),
        })),
    }));

  const stand = (i: Heft) =>
    i.progress
      ? i.progress.mode === "article"
        ? "Artikel"
        : `Seite ${i.progress.pageIndex + 1} von ${i.pageCount}`
      : null;

  const umschlag = (i: Heft) =>
    i.coverUrl ? (
      <img src={i.coverUrl} alt={i.displayTitle} loading="lazy" />
    ) : (
      <div className="cover-placeholder">{i.displayTitle[0]}</div>
    );

  const jahrgangKopf = (jahr: number | null, anzahl: number, gesamt: number) =>
    jahr !== null && (
      <div className="jahrgang-kopf">
        <h4>Jahrgang {jahr}</h4>
        {ansicht !== "liste" && (
          <div
            className="jahrgang-balken"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={gesamt}
            aria-valuenow={anzahl}
            aria-label={`Jahrgang ${jahr}: ${anzahl} von ${gesamt}`}
          >
            <span style={{ width: `${(anzahl / gesamt) * 100}%` }} />
          </div>
        )}
        <span className="jahrgang-zahl">
          {anzahl} von {gesamt}
        </span>
      </div>
    );

  return (
    <div className="page">
      <div className="page-head bibliothek-kopf">
        <div>
          <h2>Meine Ausgaben</h2>
          <p className="hint">Freigeschaltete Hefte, dauerhaft lesbar.</p>
        </div>
        <div className="segment" role="group" aria-label="Ansicht">
          {ANSICHTEN.map(([wert, text]) => (
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

      {ansicht === "kompakt" ? (
        // Alle Hefte in einer fliessenden Reihe; vor den Heften einer
        // Zeitschrift steht ein schmaler grauer Streifen mit ihrem Namen.
        <div className="kompakt-raster">
          {gruppen.map((g) => [
            <Link
              key={g.key}
              to={g.reihe ? `/zeitschrift/${g.reihe.slug}` : "/"}
              className="kompakt-trenner"
            >
              <span>{g.name}</span>
            </Link>,
            ...g.jahrgaenge.flatMap((j) =>
              j.hefte.map((i) => (
                <Link key={i._id} to={`/reader/${i._id}`} className="kompakt-heft">
                  <div className="kompakt-umschlag">{umschlag(i)}</div>
                  <div className="kompakt-titel">{i.displayTitle}</div>
                  {i.edition && <div className="kompakt-meta">{i.edition}</div>}
                </Link>
              )),
            ),
          ])}
        </div>
      ) : (
        gruppen.map((g) => (
          <section
            key={g.key}
            className={ansicht === "liste" ? "bibliothek-reihe liste" : "bibliothek-reihe"}
          >
            <h3>{g.name}</h3>
            {g.jahrgaenge.map(({ jahr, gesamt, hefte }) => (
              <div key={jahr ?? "ohne"} className="bibliothek-jahrgang">
                {jahrgangKopf(jahr, hefte.length, gesamt)}
                {ansicht === "liste" ? (
                  <ul className="heft-liste">
                    {hefte.map((i) => (
                      <li key={i._id}>
                        <Link to={`/reader/${i._id}`}>
                          <span className="heft-liste-umschlag">{umschlag(i)}</span>
                          <span className="heft-liste-text">
                            <span className="heft-liste-titel">{i.displayTitle}</span>
                            <span className="heft-liste-meta">
                              {i.edition ? `${i.edition} · ` : ""}
                              {i.pageCount} Seiten
                            </span>
                          </span>
                          {stand(i) && <span className="heft-liste-stand">{stand(i)}</span>}
                          <span className="heft-liste-go">
                            <span>{i.progress ? "Weiterlesen" : "Lesen"}</span>
                            <Icon name="arrow-right" />
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="issue-grid">
                    {hefte.map((i) => (
                      <Link key={i._id} to={`/reader/${i._id}`} className="issue-card">
                        <div className="issue-cover-preview">{umschlag(i)}</div>
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
                                <span className="where">{stand(i)}</span>
                              </>
                            ) : (
                              <span className="go">Lesen <Icon name="arrow-right" /></span>
                            )}
                          </div>
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </section>
        ))
      )}
    </div>
  );
}
