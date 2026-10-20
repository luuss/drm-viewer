import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "convex/react";
import { api, formatEuro } from "../lib/api";
import { heraus, kassenUrl, leeren, useWarenkorb } from "../lib/warenkorb";
import Icon from "../components/Icon";
import ShopHinweis from "../components/ShopHinweis";
import Kasse from "../components/Kasse";

/**
 * Auswahl im Leser. Mit Kartenkauf (leserKasse.status.aktiv) wird hier
 * bezahlt, sonst fuehrt „Zur Kasse“ in den Laden, dort liegen die Hefte schon
 * im Warenkorb. Hefte ohne Digitalausgabe im Laden fallen heraus.
 */
export default function WarenkorbPage() {
  const ids = useWarenkorb();
  const issues = useQuery(api.issues.listPublished, {});
  const storefront = useQuery(api.shopIntegration.storefront, {});
  const me = useQuery(api.users.me, {});
  const kasse = useQuery(api.leserKasse.status, {});
  const [params] = useSearchParams();
  const [kasseOffen, setKasseOffen] = useState(params.has("kaufen") || params.has("kauf"));
  // Beim Bezahlen festhalten, was gekauft wird; die Auswahl darf sich danach leeren.
  const [gekauft, setGekauft] = useState<string[] | null>(null);

  if (issues === undefined || storefront === undefined) {
    return <div className="centered">Laden...</div>;
  }

  const zeilen = (gekauft ?? ids)
    .map((id) => issues.find((i) => i._id === id))
    .filter((i): i is (typeof issues)[number] => !!i && !!i.shopSku);
  const summe = zeilen.reduce((s, i) => s + i.priceAmountCents, 0);

  function zurKasse() {
    const url = kassenUrl(
      storefront!.shopUrl,
      zeilen.map((i) => i.shopSku!),
      me?.email ?? null,
    );
    leeren();
    window.location.href = url;
  }

  return (
    <div className="page warenkorb">
      <div className="page-head">
        <h2>Warenkorb</h2>
      </div>

      {zeilen.length === 0 ? (
        <div className="empty">
          <p>Noch keine Ausgabe ausgewählt.</p>
          <Link className="btn" to="/">
            Zum Kiosk
          </Link>
        </div>
      ) : (
        <>
          <ul className="warenkorb-liste">
            {zeilen.map((i) => (
              <li key={i._id}>
                <Link to={`/issue/${i.slug}`} className="warenkorb-cover">
                  {i.coverUrl ? (
                    <img src={i.coverUrl} alt={i.displayTitle} loading="lazy" />
                  ) : (
                    <div className="cover-placeholder">{i.displayTitle[0]}</div>
                  )}
                </Link>
                <div className="warenkorb-text">
                  <div className="title">{i.publicationName ?? i.displayTitle}</div>
                  {i.publicationName && i.displayTitle !== i.publicationName && (
                    <div className="meta strong">{i.displayTitle}</div>
                  )}
                  {i.edition && <div className="meta">{i.edition}</div>}
                  <div className="meta">Digitalausgabe</div>
                </div>
                <div className="warenkorb-preis">{formatEuro(i.priceAmountCents)}</div>
                <button
                  className="btn secondary small"
                  onClick={() => heraus(i._id)}
                  aria-label={`${i.displayTitle} entfernen`}
                >
                  Entfernen
                </button>
              </li>
            ))}
          </ul>
          <div className="warenkorb-summe">
            <span>Summe</span>
            <strong>{formatEuro(summe)}</strong>
            <span className="hint">inkl. MwSt., ohne Versand</span>
          </div>
          {kasse?.aktiv ? (
            kasseOffen ? (
              <Kasse
                issueIds={zeilen.map((i) => i._id)}
                shopKasse={kassenUrl(
                  storefront.shopUrl,
                  zeilen.map((i) => i.shopSku!),
                  me?.email ?? null,
                )}
                onBezahlt={() => setGekauft(zeilen.map((i) => i._id))}
                onFertig={() => zeilen.forEach((i) => heraus(i._id))}
              />
            ) : (
              <div className="row actions">
                <button className="btn" onClick={() => setKasseOffen(true)}>
                  Zur Kasse <Icon name="arrow-right" />
                </button>
                <Link className="btn secondary" to="/">
                  Weiter aussuchen
                </Link>
              </div>
            )
          ) : (
            <>
              <div className="row actions">
                <button className="btn" onClick={zurKasse}>
                  Zur Kasse im Netzladen <Icon name="arrow-right" />
                </button>
                <Link className="btn secondary" to="/">
                  Weiter aussuchen
                </Link>
              </div>
              <p className="hint">
                Bezahlt wird im Netzladen auf lesenundschenken.de, die Hefte liegen dort schon im
                Warenkorb.
                {me?.email ? ` Die Freischaltung geht an ${me.email}.` : ""}
              </p>
              <ShopHinweis />
            </>
          )}
        </>
      )}
    </div>
  );
}
