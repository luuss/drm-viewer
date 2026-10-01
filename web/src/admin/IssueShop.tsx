import { useState } from "react";
import { Link } from "react-router-dom";
import { useAction, useMutation, useQuery } from "convex/react";
import { api, formatDate } from "../lib/api";
import { useFrage } from "../components/Frage";
import ShopDruckheft from "./ShopDruckheft";
import { MeldungZeile, useMeldung, type EditorIssue } from "./adminUi";

/**
 * Alles zum Verkauf eines Hefts an einem Ort: Zuordnung zum Druckheft im
 * Netzladen und E-Paper-Angebot, Artikelnummer von Hand, Stripe,
 * Buchanzeigen ohne Produkt und Freiexemplare.
 */
export default function IssueShop({ issue }: { issue: EditorIssue }) {
  const me = useQuery(api.users.me, {});
  const storefront = useQuery(api.shopIntegration.storefront, {});

  return (
    <div className="heft-netzladen">
      {me?.isAdmin && (
        <ShopDruckheft
          issue={{
            _id: issue._id,
            isPublished: issue.isPublished,
            shopProductId: issue.shopProductId,
            shopUrl: issue.shopUrl,
            externalSku: issue.externalSku,
            shopDigital: issue.shopDigital,
          }}
        />
      )}
      <VonHand issue={issue} />
      <Buchanzeigen issue={issue} />
      {me?.isPublisher && storefront?.stripeCheckout && <Stripe issue={issue} />}
      {me?.isPublisher && <Freiexemplare issue={issue} />}
    </div>
  );
}

function VonHand({ issue }: { issue: EditorIssue }) {
  const updateIssue = useMutation(api.issues.update);
  const [meldung, tue, busy] = useMeldung();
  return (
    <details className="karte aufklapp" open={!issue.shopProductId && !issue.externalSku}>
      <summary>Artikelnummer und Produktseite von Hand</summary>
      <form
        key={`${issue.externalSku ?? ""}:${issue.shopUrl ?? ""}`}
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          const f = e.currentTarget.elements;
          const wert = (name: string) => (f.namedItem(name) as HTMLInputElement).value;
          void tue(
            () => updateIssue({ issueId: issue._id, externalSku: wert("sku"), shopUrl: wert("url") }),
            "Gespeichert",
          );
        }}
      >
        <label className="schmal">
          Artikelnummer
          <input name="sku" defaultValue={issue.externalSku ?? ""} />
        </label>
        <label>
          Produktseite (leer = Suche)
          <input name="url" type="url" defaultValue={issue.shopUrl ?? ""} placeholder="https://" />
        </label>
        <button className="btn secondary" disabled={busy !== null}>
          Speichern
        </button>
      </form>
      <MeldungZeile meldung={meldung} />
    </details>
  );
}

function Buchanzeigen({ issue }: { issue: EditorIssue }) {
  const rows = useQuery(api.articleProducts.listForEditors, { issueId: issue._id });
  const rematch = useMutation(api.articleProducts.rematch);
  const [meldung, tue, busy] = useMeldung();
  if (!rows?.length) return null;
  const offen = rows.filter((r) => !r.product && r.source !== "editor");
  const verknuepft = rows.filter((r) => r.product).length;

  return (
    <section className="karte">
      <h3>Buchanzeigen</h3>
      <p className="hint">
        {verknuepft} mit Produkt im Netzladen
        {offen.length ? ` · ${offen.length} ohne Produkt` : ""}
      </p>
      {offen.length > 0 && (
        <ul className="links-liste">
          {offen.map((r) => (
            <li key={r._id}>
              <span>{r.label}</span>
              <Link className="btn quiet small" to={`/admin/heft/${issue._id}/artikel`}>
                Im Artikel {r.articleOrder} zuordnen
              </Link>
            </li>
          ))}
        </ul>
      )}
      <button
        className="btn secondary small"
        disabled={busy !== null}
        onClick={() => tue(() => rematch({ issueId: issue._id }), "Abgleich läuft, die Liste füllt sich von selbst")}
      >
        Mit dem Netzladen abgleichen
      </button>
      <MeldungZeile meldung={meldung} />
    </section>
  );
}

function Stripe({ issue }: { issue: EditorIssue }) {
  const ensurePrice = useAction(api.billing.ensureIssuePrice);
  const [meldung, tue, busy] = useMeldung();
  return (
    <section className="karte">
      <h3>Stripe</h3>
      <p className="hint">
        {issue.stripePriceId ? "Preis ist angelegt." : "Noch kein Preis bei Stripe angelegt."}
      </p>
      <button
        className="btn secondary small"
        disabled={busy !== null}
        aria-busy={busy !== null}
        onClick={() => tue(() => ensurePrice({ issueId: issue._id }), "Preis angelegt")}
      >
        {issue.stripePriceId ? "Preis neu abgleichen" : "Preis anlegen"}
      </button>
      <MeldungZeile meldung={meldung} />
    </section>
  );
}

function Freiexemplare({ issue }: { issue: EditorIssue }) {
  const frage = useFrage();
  const grants = useQuery(api.entitlements.listGrants, { issueId: issue._id });
  const grant = useMutation(api.entitlements.grantByEmail);
  const revoke = useMutation(api.entitlements.revokeGrant);
  const [email, setEmail] = useState("");
  const [meldung, tue, busy] = useMeldung();

  return (
    <section className="karte">
      <h3>Freiexemplare</h3>
      <p className="hint">Für Rezensionen und Autoren: das Heft für ein bestehendes Konto freischalten.</p>
      <form
        className="inline-form short"
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await tue(
            () => grant({ issueId: issue._id, email: email.trim() }),
            `${email.trim()} freigeschaltet`,
          );
          if (ok) setEmail("");
        }}
      >
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="E-Mail-Adresse"
          aria-label="E-Mail-Adresse"
          required
        />
        <button className="btn secondary" disabled={busy !== null}>
          Freischalten
        </button>
      </form>
      <MeldungZeile meldung={meldung} />
      {grants && grants.length > 0 && (
        <ul className="links-liste">
          {grants.map((g) => (
            <li key={g._id}>
              <span>{g.email ?? "(ohne Adresse)"}</span>
              <span className="hint small">{formatDate(g.createdAt)}</span>
              <button
                className="btn quiet small danger"
                onClick={async () => {
                  const weiter = await frage({
                    titel: "Freiexemplar zurücknehmen?",
                    text: `${g.email ?? "Dieses Konto"} kann das Heft danach nicht mehr lesen (außer es hat es gekauft).`,
                    ja: "Zurücknehmen",
                    gefahr: true,
                  });
                  if (weiter) await tue(() => revoke({ entitlementId: g._id }));
                }}
              >
                Zurücknehmen
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
