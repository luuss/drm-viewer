import { useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api, type Id } from "../lib/api";
import { MeldungZeile, useMeldung } from "./adminUi";

type Reihe = FunctionReturnType<typeof api.publications.listAll>[number];

/** Einstellungen der Verwaltung: Reihen, Netzladen, Personen. */
export default function Settings() {
  const me = useQuery(api.users.me, {});
  if (me === undefined) return <p className="hint">Laden...</p>;
  if (!me?.isAdmin) {
    return (
      <div className="empty">
        <p>Die Einstellungen sind der Verwaltung vorbehalten.</p>
      </div>
    );
  }
  return (
    <div className="einstellungen">
      <Reihen />
      <Netzladen />
      <Personen meId={me._id} />
    </div>
  );
}

function Reihen() {
  const publications = useQuery(api.publications.listAll, {});
  const createPublication = useMutation(api.publications.create);
  const [meldung, tue, busy] = useMeldung();
  const [name, setName] = useState("");

  return (
    <section className="einstellungen-abschnitt">
      <h2>Reihen</h2>
      <div className="karten-gitter">
        {publications?.map((p) => <ReiheKarte key={p._id} reihe={p} />)}
      </div>
      <form
        className="inline-form short"
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await tue(() => createPublication({ name: name.trim() }), "Reihe angelegt");
          if (ok !== undefined) setName("");
        }}
      >
        <label>
          Neue Reihe
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. ZUERST!" required />
        </label>
        <button className="btn secondary" disabled={busy !== null}>
          Anlegen
        </button>
      </form>
      <MeldungZeile meldung={meldung} />
    </section>
  );
}

function ReiheKarte({ reihe: p }: { reihe: Reihe }) {
  const updateShop = useMutation(api.publications.updateShop);
  const setActive = useMutation(api.publications.setActive);
  const [meldung, tue, busy] = useMeldung();

  return (
    <form
      key={`${p.shopSubscriptionSku ?? ""}:${p.shopSubscriptionMonths ?? ""}:${p.shopSubscriptionUrl ?? ""}:${p.shopPrintSubscriptionUrl ?? ""}`}
      className="karte stack-form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = e.currentTarget.elements;
        const wert = (name: string) => (f.namedItem(name) as HTMLInputElement).value;
        const monate = wert("months").trim();
        void tue(
          () =>
            updateShop({
              publicationId: p._id,
              shopSubscriptionSku: wert("sku"),
              shopSubscriptionMonths: monate ? Number(monate) : null,
              shopSubscriptionUrl: wert("url"),
              shopPrintSubscriptionUrl: wert("printUrl"),
            }),
          "Gespeichert",
        );
      }}
    >
      <div className="karte-kopf">
        <h3>{p.name}</h3>
        <span className="hint small">/{p.slug}</span>
        <label className="consent schalter">
          <input
            type="checkbox"
            checked={p.isActive}
            onChange={(e) =>
              tue(
                () => setActive({ publicationId: p._id, isActive: e.target.checked }),
                e.target.checked ? "Aktiv" : "Inaktiv",
              )
            }
          />
          aktiv
        </label>
      </div>
      <h4>Digital-Abo im Netzladen</h4>
      <div className="feld-reihe">
        <label>
          Artikelnummer
          <input name="sku" defaultValue={p.shopSubscriptionSku ?? ""} />
        </label>
        <label className="schmal">
          Laufzeit in Monaten
          <input
            name="months"
            type="number"
            min="1"
            max="120"
            step="1"
            defaultValue={p.shopSubscriptionMonths ?? ""}
            placeholder="12"
          />
        </label>
      </div>
      <label>
        Produktseite des Digital-Abos
        <input name="url" type="url" defaultValue={p.shopSubscriptionUrl ?? ""} placeholder="https://" />
      </label>
      <label>
        Abo-Formular des Druckhefts (Ziel der Abo-Aufrufe im Heft)
        <input
          name="printUrl"
          type="url"
          defaultValue={p.shopPrintSubscriptionUrl ?? ""}
          placeholder="leer = bekanntes Formular des Ladens"
        />
      </label>
      <button className="btn secondary" disabled={busy !== null}>
        Speichern
      </button>
      <MeldungZeile meldung={meldung} />
    </form>
  );
}

function Netzladen() {
  const ladenAbgleich = useAction(api.publicationCovers.refreshNow);
  const [meldung, tue, busy] = useMeldung();
  const [ergebnis, setErgebnis] = useState<{ missing: string[]; failed: string[] } | null>(null);

  return (
    <section className="einstellungen-abschnitt">
      <h2>Netzladen</h2>
      <div className="karte stack-form breit">
        <p className="hint">
          Preise, Titelbilder und Heftbezeichnungen kommen aus dem Netzladen. Der Abgleich läuft
          jede Nacht von selbst; nach einer Änderung im Laden lässt er sich hier sofort anstoßen.
        </p>
        <button
          className="btn secondary"
          disabled={busy !== null}
          aria-busy={busy !== null}
          onClick={() =>
            tue(
              async () => {
                const r = await ladenAbgleich({});
                setErgebnis(r);
                return r;
              },
              (r) =>
                [
                  `${r.issues.length} Hefte abgeglichen`,
                  r.missing.length ? `${r.missing.length} nicht gefunden` : "",
                  r.failed.length ? `${r.failed.length} fehlgeschlagen` : "",
                ]
                  .filter(Boolean)
                  .join(" · "),
            )
          }
        >
          {busy ? "Wird abgeglichen…" : "Jetzt abgleichen"}
        </button>
        <MeldungZeile meldung={meldung} />
        {ergebnis && ergebnis.missing.length > 0 && (
          <div>
            <h4>Im Netzladen nicht gefunden</h4>
            <ul className="nachtrag">
              {ergebnis.missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        )}
        {ergebnis && ergebnis.failed.length > 0 && (
          <div>
            <h4>Fehlgeschlagen</h4>
            <ul className="nachtrag">
              {ergebnis.failed.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

const ROLLEN = [
  ["customer", "Leser"],
  ["editor", "Redaktion"],
  ["publisher", "Verlag"],
  ["admin", "Verwaltung"],
] as const;
type Rolle = (typeof ROLLEN)[number][0];

const ROLLE_HINWEIS: Record<Rolle, string> = {
  customer: "liest, was gekauft ist",
  editor: "bearbeitet Hefte und Artikel",
  publisher: "dazu veröffentlichen, löschen, Freiexemplare",
  admin: "dazu Netzladen, Reihen und Personen",
};

/** Die hoechste Rolle zaehlt; die geringeren sind darin enthalten. */
function hoechste(roles: string[]): Rolle {
  for (const r of ["admin", "publisher", "editor"] as const) if (roles.includes(r)) return r;
  return "customer";
}

function Personen({ meId }: { meId: Id<"users"> }) {
  const users = useQuery(api.users.listForAdmin, {});
  const setRoles = useMutation(api.users.setRoles);
  const [suche, setSuche] = useState("");
  const [meldung, tue, busy] = useMeldung();

  const gezeigt = useMemo(() => {
    const q = suche.trim().toLowerCase();
    return (users ?? [])
      .filter((u) =>
        q
          ? (u.email ?? "").toLowerCase().includes(q) || (u.name ?? "").toLowerCase().includes(q)
          : hoechste(u.roles) !== "customer",
      )
      .sort((a, b) => (a.email ?? "").localeCompare(b.email ?? ""))
      .slice(0, 100);
  }, [users, suche]);

  return (
    <section className="einstellungen-abschnitt">
      <h2>Personen</h2>
      <div className="karte stack-form breit">
        <label>
          Konto suchen
          <input
            type="search"
            value={suche}
            onChange={(e) => setSuche(e.target.value)}
            placeholder="E-Mail-Adresse oder Name"
          />
        </label>
        <p className="hint small">
          {suche.trim() ? `${gezeigt.length} Treffer` : "Ohne Suche stehen hier alle mit Rechten über das Lesen hinaus."}
        </p>
        <MeldungZeile meldung={meldung} />
        <ul className="personen">
          {gezeigt.map((u) => {
            const rolle = hoechste(u.roles);
            return (
              <li key={u._id}>
                <span className="wer">
                  <strong>{u.email ?? "(ohne Adresse)"}</strong>
                  {u.name ? <span className="hint small"> {u.name}</span> : null}
                </span>
                <select
                  value={rolle}
                  aria-label={`Rolle von ${u.email ?? "Konto"}`}
                  disabled={busy !== null || (u._id === meId && rolle === "admin")}
                  title={ROLLE_HINWEIS[rolle]}
                  onChange={(e) =>
                    tue(
                      () => setRoles({ userId: u._id, roles: [e.target.value] }),
                      `${u.email}: ${ROLLEN.find(([k]) => k === e.target.value)?.[1]}`,
                    )
                  }
                >
                  {ROLLEN.map(([k, text]) => (
                    <option key={k} value={k}>
                      {text} — {ROLLE_HINWEIS[k]}
                    </option>
                  ))}
                </select>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
