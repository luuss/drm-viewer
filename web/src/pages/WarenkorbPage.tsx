import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "convex/react";
import { api, formatEuro, type Id } from "../lib/api";
import { aboReihe, heraus, kassenUrl, leeren, useWarenkorb } from "../lib/warenkorb";
import Icon from "../components/Icon";
import ShopHinweis from "../components/ShopHinweis";
import Kasse from "../components/Kasse";

type Zeile = {
  eintrag: string;
  issueId?: Id<"issues">;
  publicationId?: Id<"publications">;
  link: string;
  coverUrl: string | null;
  titel: string;
  /** Hefttitel (hervorgehoben), Ausgabe, Art. */
  heft?: string;
  zeilen: string[];
  sku: string;
  preisCents: number | null;
};

/**
 * Auswahl im Leser: Hefte und Digital-Abos. Mit Kartenkauf
 * (leserKasse.status.aktiv) wird hier bezahlt, sonst fuehrt „Zur Kasse“ in
 * den Laden, dort liegt alles schon im Warenkorb. Was keine Artikelnummer im
 * Laden hat, faellt heraus.
 */
export default function WarenkorbPage() {
  const ids = useWarenkorb();
  const issues = useQuery(api.issues.listPublished, {});
  const offers = useQuery(api.plans.offers, {});
  const storefront = useQuery(api.shopIntegration.storefront, {});
  const me = useQuery(api.users.me, {});
  const kasse = useQuery(api.leserKasse.status, {});
  const [params] = useSearchParams();
  const [kasseOffen, setKasseOffen] = useState(params.has("kaufen") || params.has("kauf"));
  // Beim Bezahlen festhalten, was gekauft wird; die Auswahl darf sich danach leeren.
  const [gekauft, setGekauft] = useState<string[] | null>(null);

  if (issues === undefined || offers === undefined || storefront === undefined) {
    return <div className="centered">Laden...</div>;
  }

  const zeilen: Zeile[] = (gekauft ?? ids).flatMap((eintrag): Zeile[] => {
    const reihe = aboReihe(eintrag);
    if (reihe) {
      const o = offers.find((x) => x.publicationId === reihe);
      if (!o?.digitalAbo) return [];
      return [
        {
          eintrag,
          publicationId: o.publicationId,
          link: `/abo/${o.publicationSlug}`,
          coverUrl: o.coverUrl,
          titel: o.publicationName,
          zeilen: [`Digital-Abo, ${o.digitalAbo.months} Monate`],
          sku: o.digitalAbo.sku,
          preisCents: o.digitalAbo.priceAmountCents,
        },
      ];
    }
    const i = issues.find((x) => x._id === eintrag);
    if (!i?.shopSku) return [];
    return [
      {
        eintrag,
        issueId: i._id,
        link: `/issue/${i.slug}`,
        coverUrl: i.coverUrl,
        titel: i.publicationName ?? i.displayTitle,
        heft:
          i.publicationName && i.displayTitle !== i.publicationName ? i.displayTitle : undefined,
        zeilen: [...(i.edition ? [i.edition] : []), "Digitalausgabe"],
        sku: i.shopSku,
        preisCents: i.priceAmountCents,
      },
    ];
  });
  const preiseBekannt = zeilen.every((z) => z.preisCents !== null);
  const summe = zeilen.reduce((s, z) => s + (z.preisCents ?? 0), 0);
  const issueIds = zeilen.flatMap((z) => (z.issueId ? [z.issueId] : []));
  const aboPublicationIds = zeilen.flatMap((z) => (z.publicationId ? [z.publicationId] : []));
  const shopKasse = kassenUrl(
    storefront.shopUrl,
    zeilen.map((z) => z.sku),
    me?.email ?? null,
  );

  function zurKasse() {
    leeren();
    window.location.href = shopKasse;
  }

  return (
    <div className="page warenkorb">
      <div className="page-head">
        <h2>Warenkorb</h2>
      </div>

      {zeilen.length === 0 ? (
        <div className="empty">
          <p>Noch nichts ausgewählt.</p>
          <Link className="btn" to="/">
            Zum Kiosk
          </Link>
        </div>
      ) : (
        <>
          <ul className="warenkorb-liste">
            {zeilen.map((z) => (
              <li key={z.eintrag}>
                <Link to={z.link} className="warenkorb-cover">
                  {z.coverUrl ? (
                    <img src={z.coverUrl} alt={z.titel} loading="lazy" />
                  ) : (
                    <div className="cover-placeholder">{z.titel[0]}</div>
                  )}
                </Link>
                <div className="warenkorb-text">
                  <div className="title">{z.titel}</div>
                  {z.heft && <div className="meta strong">{z.heft}</div>}
                  {z.zeilen.map((t) => (
                    <div key={t} className="meta">
                      {t}
                    </div>
                  ))}
                </div>
                <div className="warenkorb-preis">
                  {z.preisCents !== null ? formatEuro(z.preisCents) : "–"}
                </div>
                <button
                  className="btn secondary small"
                  onClick={() => heraus(z.eintrag)}
                  aria-label={`${z.titel} entfernen`}
                >
                  Entfernen
                </button>
              </li>
            ))}
          </ul>
          <div className="warenkorb-summe">
            <span>Summe</span>
            <strong>{preiseBekannt ? formatEuro(summe) : "–"}</strong>
            <span className="hint">inkl. MwSt., ohne Versand</span>
          </div>
          {kasse?.aktiv ? (
            kasseOffen ? (
              <Kasse
                issueIds={issueIds}
                aboPublicationIds={aboPublicationIds}
                shopKasse={shopKasse}
                onBezahlt={() => setGekauft(zeilen.map((z) => z.eintrag))}
                onFertig={() => zeilen.forEach((z) => heraus(z.eintrag))}
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
                Bezahlt wird im Netzladen auf lesenundschenken.de, die Auswahl liegt dort schon im
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
