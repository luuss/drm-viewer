import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api, type Id } from "../lib/api";
import Icon from "../components/Icon";
import Seitenbild, { useSeiten, type Box } from "./Seitenbild";
import { MeldungZeile, seitenName, useMeldung } from "./adminUi";

type Link = FunctionReturnType<typeof api.pageLinks.listForEditors>[number];
type Art = Link["kind"];

const ART: Record<Art, string> = {
  subscription: "Abo-Formular einer Reihe",
  series: "Reihe im Netzladen",
  shop: "Produkt oder Suche im Netzladen",
  url: "Feste Adresse",
};

type Entwurf = Box & {
  linkId: Id<"pageLinks"> | null;
  kind: Art;
  publicationSlug: string;
  reference: string;
  queries: string;
  url: string;
  label: string;
};

function entwurfAus(l: Link): Entwurf {
  return {
    linkId: l._id,
    x0: l.x0,
    y0: l.y0,
    x1: l.x1,
    y1: l.y1,
    kind: l.kind,
    publicationSlug: l.publicationSlug ?? "",
    reference: l.reference ?? "",
    queries: l.queries.join(", "),
    url: l.kind === "url" ? (l.url ?? "") : "",
    label: l.label ?? "",
  };
}

/**
 * Klickflaechen auf den Seiten, die nach draussen fuehren: Abo-Aufrufe und
 * Anzeigen. Der Import legt sie an; hier lassen sie sich pruefen, aendern,
 * loeschen und neu aufziehen. Was die Redaktion anfasst, uebersteht einen
 * neuen Import.
 */
export default function PageLinksEditor({ issueId }: { issueId: Id<"issues"> }) {
  const { seiten, labels } = useSeiten(issueId);
  const links = useQuery(api.pageLinks.listForEditors, { issueId });
  const [seite, setSeite] = useState(0);
  const [entwurf, setEntwurf] = useState<Entwurf | null>(null);
  /** Zaehlt neu aufgezogene Flaechen, damit jede ein frisches Formular bekommt. */
  const [neu, setNeu] = useState(0);

  const jeSeite = useMemo(() => {
    const m = new Map<number, number>();
    for (const l of links ?? []) m.set(l.pageIndex, (m.get(l.pageIndex) ?? 0) + 1);
    return m;
  }, [links]);

  // Seitenwechsel verwirft einen halben Entwurf.
  useEffect(() => setEntwurf(null), [seite]);

  if (seiten === undefined || links === undefined) return <p className="hint">Laden...</p>;
  if (seiten.length === 0) {
    return (
      <div className="empty">
        <p>Noch keine Seiten.</p>
      </div>
    );
  }

  const aufSeite = links.filter((l) => l.pageIndex === seite);
  const mitFlaechen = [...jeSeite.keys()].sort((a, b) => a - b);

  return (
    <div className="links-editor">
      <div className="review-leiste">
        <div className="seiten-wahl">
          <button
            className="btn secondary small"
            aria-label="Vorige Seite"
            disabled={seite <= 0}
            onClick={() => setSeite(seite - 1)}
          >
            <Icon name="arrow-left" />
          </button>
          <select value={seite} onChange={(e) => setSeite(Number(e.target.value))} aria-label="Seite">
            {seiten.map((s) => (
              <option key={s.index} value={s.index}>
                S. {seitenName(labels, s.index)}
                {jeSeite.get(s.index) ? ` · ${jeSeite.get(s.index)} Flächen` : ""}
              </option>
            ))}
          </select>
          <button
            className="btn secondary small"
            aria-label="Nächste Seite"
            disabled={seite >= seiten.length - 1}
            onClick={() => setSeite(seite + 1)}
          >
            <Icon name="arrow-right" />
          </button>
        </div>
        {mitFlaechen.length > 0 && (
          <span className="hint small">
            Flächen auf S.{" "}
            {mitFlaechen.map((i, n) => (
              <span key={i}>
                {n > 0 ? ", " : ""}
                <button className="btn quiet small" onClick={() => setSeite(i)}>
                  {seitenName(labels, i)}
                </button>
              </span>
            ))}
          </span>
        )}
      </div>

      <div className="links-split">
        <div className="links-seite">
          <Seitenbild
            seite={seiten.find((s) => s.index === seite)}
            flaechen={[
              ...aufSeite
                .filter((l) => l._id !== entwurf?.linkId)
                .map((l) => ({
                  ...l,
                  key: l._id,
                  klasse: `link ${l.source}`,
                  titel: l.label ?? ART[l.kind],
                  onClick: () => setEntwurf(entwurfAus(l)),
                })),
            ]}
            bearbeiten={
              entwurf
                ? { box: entwurf, onChange: (box) => setEntwurf((alt) => (alt ? { ...alt, ...box } : alt)) }
                : undefined
            }
            onZiehen={(box) => {
              setNeu((n) => n + 1);
              setEntwurf({
                linkId: null,
                ...box,
                kind: "shop",
                publicationSlug: "",
                reference: "",
                queries: "",
                url: "",
                label: "",
              });
            }}
          />
          <p className="hint small">
            Neue Fläche: auf der Seite ein Rechteck aufziehen. Eine gewählte Fläche lässt sich
            verschieben und an Ecken und Kanten verziehen.
          </p>
        </div>

        <aside className="links-formular">
          {entwurf ? (
            <LinkFormular
              key={entwurf.linkId ?? `neu:${neu}`}
              issueId={issueId}
              seite={seite}
              entwurf={entwurf}
              box={entwurf}
              link={links.find((l) => l._id === entwurf.linkId) ?? null}
              fertig={() => setEntwurf(null)}
            />
          ) : (
            <>
              <h4>Flächen auf dieser Seite</h4>
              {aufSeite.length === 0 ? (
                <p className="hint">Keine.</p>
              ) : (
                <ul className="links-liste">
                  {aufSeite.map((l) => (
                    <li key={l._id}>
                      <button className="btn quiet small" onClick={() => setEntwurf(entwurfAus(l))}>
                        {l.label || ART[l.kind]}
                      </button>
                      <span className="badge">{l.source === "editor" ? "Redaktion" : "Import"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

function LinkFormular({
  issueId,
  seite,
  entwurf,
  box,
  link,
  fertig,
}: {
  issueId: Id<"issues">;
  seite: number;
  entwurf: Entwurf;
  /** Die Lage kommt von aussen: sie aendert sich beim Verziehen auf der Seite. */
  box: Box;
  link: Link | null;
  fertig: () => void;
}) {
  const publications = useQuery(api.publications.listAll, {});
  const save = useMutation(api.pageLinks.save);
  const remove = useMutation(api.pageLinks.remove);
  const [e, setE] = useState(entwurf);
  const [meldung, tue, busy] = useMeldung();
  const setze = (teil: Partial<Entwurf>) => setE({ ...e, ...teil });

  return (
    <form
      className="stack-form"
      onSubmit={async (ev) => {
        ev.preventDefault();
        const ok = await tue(() =>
          save({
            issueId,
            linkId: e.linkId ?? undefined,
            link: {
              pageIndex: seite,
              x0: box.x0,
              y0: box.y0,
              x1: box.x1,
              y1: box.y1,
              kind: e.kind,
              publicationSlug: e.publicationSlug || undefined,
              url: e.url.trim() || undefined,
              reference: e.reference.trim() || undefined,
              queries: e.queries
                .split(/[,\n]/)
                .map((q) => q.trim())
                .filter(Boolean),
              label: e.label.trim() || undefined,
            },
          }),
        );
        if (ok) fertig();
      }}
    >
      <h4>{e.linkId ? "Fläche" : "Neue Fläche"}</h4>
      {link && (
        <p className="hint small">
          {link.source === "editor" ? "Von der Redaktion" : "Vom Import angelegt"}
          {link.target && (
            <>
              {" · führt zu "}
              <a href={link.target} target="_blank" rel="noopener noreferrer">
                {link.target.replace(/^https?:\/\//, "").slice(0, 48)}
              </a>
            </>
          )}
        </p>
      )}
      <label>
        Ziel
        <select value={e.kind} onChange={(ev) => setze({ kind: ev.target.value as Art })}>
          {(Object.keys(ART) as Art[]).map((k) => (
            <option key={k} value={k}>
              {ART[k]}
            </option>
          ))}
        </select>
      </label>
      {(e.kind === "subscription" || e.kind === "series") && (
        <label>
          Reihe
          <select
            value={e.publicationSlug}
            onChange={(ev) => setze({ publicationSlug: ev.target.value })}
            required
          >
            <option value="">wählen</option>
            {publications?.map((p) => (
              <option key={p._id} value={p.slug}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {e.kind === "shop" && (
        <>
          <label>
            Artikelnummer
            <input value={e.reference} onChange={(ev) => setze({ reference: ev.target.value })} />
          </label>
          <label>
            Suchbegriffe, durch Komma getrennt
            <input value={e.queries} onChange={(ev) => setze({ queries: ev.target.value })} />
          </label>
        </>
      )}
      {e.kind === "url" && (
        <label>
          Adresse
          <input
            type="url"
            value={e.url}
            placeholder="https://"
            onChange={(ev) => setze({ url: ev.target.value })}
            required
          />
        </label>
      )}
      <label>
        Beschriftung (für Vorleser)
        <input value={e.label} onChange={(ev) => setze({ label: ev.target.value })} />
      </label>
      <div className="row">
        <button className="btn" disabled={busy !== null} aria-busy={busy !== null}>
          Speichern
        </button>
        <button type="button" className="btn secondary" onClick={fertig}>
          Abbrechen
        </button>
        {e.linkId && (
          <button
            type="button"
            className="btn quiet danger"
            disabled={busy !== null}
            onClick={async () => {
              await tue(() => remove({ linkId: e.linkId! }));
              fertig();
            }}
          >
            Löschen
          </button>
        )}
      </div>
      {link?.source === "import" && (
        <p className="hint small">
          Nach dem Speichern gehört die Fläche der Redaktion und bleibt bei einer neuen
          Aufbereitung erhalten.
        </p>
      )}
      <MeldungZeile meldung={meldung} />
    </form>
  );
}
