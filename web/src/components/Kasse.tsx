import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAction, useQuery } from "convex/react";
import type { Stripe, StripeElements } from "@stripe/stripe-js";
import type { FunctionReturnType } from "convex/server";
import { api, cleanError, formatEuro, type Id } from "../lib/api";
import { STRIPE_AUSSEHEN, stripeLaden } from "../lib/stripe";
import MagicLinkForm from "./MagicLinkForm";

/**
 * Kasse im Leser: Kartenzahlung mit Stripe, ohne Umleitung. Beim ersten Kauf
 * Karte im Payment Element, danach ein Klick mit der gespeicherten Karte.
 * Gebucht wird im Shop (Rechnung, Umsatz); die Freischaltung kommt von dort.
 * Andere Zahlarten fuehren weiter in die Kasse des Shops.
 *
 * Rechtliches: Knopf „Jetzt zahlungspflichtig kaufen“ mit Preis (§ 312j BGB),
 * Preis inkl. MwSt., Widerrufsverzicht fuer digitale Inhalte vor jedem Kauf.
 */

type Adresse = {
  vorname: string;
  nachname: string;
  firma?: string;
  strasse: string;
  zusatz?: string;
  plz: string;
  ort: string;
  land: string;
};

const LEER: Adresse = { vorname: "", nachname: "", strasse: "", plz: "", ort: "", land: "DE" };

type Angebot = {
  betragCents: number;
  steuerCents: number;
  positionen: { steuersatz: number | null }[];
};

export type KasseProps = {
  issueIds: Id<"issues">[];
  /** Kasse des Shops fuer andere Zahlarten (Rechnung, Vorkasse, SEPA). */
  shopKasse: string | null;
  /** Wohin „Jetzt lesen“ nach der Freischaltung fuehrt. */
  leseZiel?: string;
  /** Sobald eine Zahlung durch ist (Stand statt Formular). */
  onBezahlt?: () => void;
  /** Einmal, sobald alles freigeschaltet ist. */
  onFertig?: () => void;
};

export default function Kasse(props: KasseProps) {
  const status = useQuery(api.leserKasse.status, {});
  if (status === undefined) {
    return (
      <div className="kasse">
        <p className="hint">Kasse wird geladen …</p>
      </div>
    );
  }
  if (!status.aktiv) return null;
  if (!status.angemeldet) return <KasseGast shopKasse={props.shopKasse} />;
  return <KasseKonto {...props} status={status} />;
}

function ShopLink({ href }: { href: string | null }) {
  if (!href) return null;
  return (
    <a className="kasse-andere" href={href}>
      Andere Zahlart (Rechnung, Vorkasse, SEPA) im Shop
    </a>
  );
}

function KasseGast({ shopKasse }: { shopKasse: string | null }) {
  const next = `${window.location.pathname}?kaufen=1`;
  return (
    <div className="kasse">
      <h3>Kaufen</h3>
      <p className="hint">
        Zum Bezahlen mit Karte melden Sie sich mit Ihrer E-Mail-Adresse an. Die Ausgabe liegt
        danach in Ihrer Bibliothek, und die Karte bleibt auf Wunsch für den nächsten Kauf
        gespeichert.
      </p>
      <MagicLinkForm next={next} />
      <ShopLink href={shopKasse} />
    </div>
  );
}

type Status = Extract<FunctionReturnType<typeof api.leserKasse.status>, { aktiv: true }>;

function KasseKonto({
  issueIds,
  shopKasse,
  leseZiel,
  onBezahlt,
  onFertig,
  status,
}: KasseProps & { status: Status }) {
  const me = useQuery(api.users.me, {});
  const waiver = useQuery(api.consents.currentWaiver, {});
  const angebotHolen = useAction(api.leserZahlung.angebot);
  const kaufenAktion = useAction(api.leserZahlung.kaufen);
  const kaufPruefen = useAction(api.leserZahlung.kaufPruefen);

  const [adresse, setAdresse] = useState<Adresse>(status.adresse ?? LEER);
  const [adresseOffen, setAdresseOffen] = useState(!status.adresse);
  const [angebot, setAngebot] = useState<Angebot | null>(null);
  const [angebotFehler, setAngebotFehler] = useState<string | null>(null);
  const [neueKarte, setNeueKarte] = useState(!status.karte);
  const [speichern, setSpeichern] = useState(true);
  const [verzicht, setVerzicht] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [kaufId, setKaufId] = useState<Id<"leserKaeufe"> | null>(null);
  const [runde, setRunde] = useState(0);
  const [karteBereit, setKarteBereit] = useState(false);
  const karte = useRef<{ stripe: Stripe; elements: StripeElements } | null>(null);

  const schluessel = issueIds.join(",");
  const land = adresse.land;
  const zahlweise: "gespeichert" | "neu" = status.karte && !neueKarte ? "gespeichert" : "neu";

  // Gespeicherte Adresse nachtragen, sobald sie da ist.
  useEffect(() => {
    if (status.adresse && !adresseOffen) setAdresse(status.adresse);
  }, [status.adresse, adresseOffen]);

  // Rueckkehr von einer Bankseite (?kauf=…): Stand abfragen.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("kauf");
    if (!id) return;
    setKaufId(id as Id<"leserKaeufe">);
    kaufPruefen({ kaufId: id as Id<"leserKaeufe"> }).catch(() => undefined);
  }, [kaufPruefen]);

  // Preis aus dem Shop, je Auswahl und Land.
  useEffect(() => {
    let aktiv = true;
    setAngebotFehler(null);
    angebotHolen({ issueIds, land })
      .then((a) => aktiv && setAngebot(a))
      .catch((e) => {
        if (!aktiv) return;
        setAngebot(null);
        setAngebotFehler(cleanError(e));
      });
    return () => {
      aktiv = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schluessel, land, runde, angebotHolen]);

  const steuerText = useMemo(() => {
    if (!angebot) return "inkl. MwSt.";
    const saetze = [...new Set(angebot.positionen.map((p) => p.steuersatz).filter((s) => s !== null))];
    const satz = saetze.length === 1 ? `${String(saetze[0]).replace(".", ",")} % ` : "";
    return `inkl. ${satz}MwSt. (${formatEuro(angebot.steuerCents)})`;
  }, [angebot]);

  if (kaufId) {
    return (
      <KaufStand
        kaufId={kaufId}
        leseZiel={leseZiel}
        onFertig={onFertig}
        onNeu={() => {
          setKaufId(null);
          setVerzicht(false);
        }}
      />
    );
  }

  const feld = (k: keyof Adresse) => ({
    value: adresse[k] ?? "",
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setAdresse({ ...adresse, [k]: e.target.value }),
  });

  const bereit =
    !!angebot && verzicht && !busy && (zahlweise === "gespeichert" || karteBereit);

  async function kaufen() {
    if (!angebot) return;
    setErr(null);
    setBusy(true);
    let neuerKauf: Id<"leserKaeufe"> | null = null;
    try {
      const k = karte.current;
      if (zahlweise === "neu") {
        if (!k) throw new Error("Das Kartenfeld ist noch nicht bereit.");
        const { error } = await k.elements.submit();
        if (error) throw new Error(error.message ?? "Bitte die Kartendaten prüfen.");
      }
      const r = await kaufenAktion({
        issueIds,
        erwarteterBetragCents: angebot.betragCents,
        widerrufsverzicht: verzicht,
        zahlweise,
        karteSpeichern: speichern,
        adresse: adresseOffen ? adresse : undefined,
      });
      neuerKauf = r.kaufId;
      if (r.status === "bestaetigen" && k && r.clientSecret) {
        const { error } = await k.stripe.confirmPayment({
          elements: k.elements,
          clientSecret: r.clientSecret,
          redirect: "if_required",
          confirmParams: {
            return_url: `${window.location.origin}${window.location.pathname}?kauf=${r.kaufId}`,
            payment_method_data: {
              billing_details: {
                name: `${adresse.vorname} ${adresse.nachname}`.trim(),
                email: me?.email ?? "",
                address: {
                  line1: adresse.strasse,
                  line2: adresse.zusatz ?? "",
                  postal_code: adresse.plz,
                  city: adresse.ort,
                  state: "",
                  country: adresse.land,
                },
              },
            },
          },
        });
        if (error) {
          await kaufPruefen({ kaufId: r.kaufId }).catch(() => undefined);
          throw new Error(error.message ?? "Die Zahlung wurde nicht bestätigt.");
        }
      } else if (r.status === "aktion" && r.clientSecret) {
        const stripe = await stripeLaden(status.publishableKey);
        if (!stripe) throw new Error("Stripe ließ sich nicht laden.");
        const { error } = await stripe.handleNextAction({ clientSecret: r.clientSecret });
        if (error) {
          await kaufPruefen({ kaufId: r.kaufId }).catch(() => undefined);
          throw new Error(error.message ?? "Die Bank hat die Zahlung nicht bestätigt.");
        }
      }
      const p = await kaufPruefen({ kaufId: r.kaufId });
      if (p.status === "fehlgeschlagen") throw new Error(p.fehler ?? "Die Zahlung ist fehlgeschlagen.");
      setAdresseOffen(false);
      setKaufId(r.kaufId);
      onBezahlt?.();
    } catch (e) {
      const text = cleanError(e);
      setErr(text);
      if (/Preis hat sich geändert/.test(text)) setRunde((n) => n + 1);
      if (neuerKauf) setVerzicht(false);
    } finally {
      setBusy(false);
    }
  }

  const knopf = angebot
    ? `Jetzt zahlungspflichtig kaufen – ${formatEuro(angebot.betragCents)}${
        zahlweise === "gespeichert" && status.karte ? ` mit ${status.karte.name}` : ""
      }`
    : "Jetzt zahlungspflichtig kaufen";

  return (
    <div className="kasse">
      <h3>Kaufen</h3>
      {status.modus === "test" && (
        <div className="kasse-test">
          Testmodus: Es wird nichts belastet. Testkarte 4242 4242 4242 4242, beliebiges Datum in
          der Zukunft, beliebige Prüfnummer.
        </div>
      )}

      <section className="kasse-teil">
        <h4>Rechnungsadresse</h4>
        {adresseOffen ? (
          <div className="kasse-adresse">
            <label>
              Vorname
              <input {...feld("vorname")} autoComplete="given-name" required />
            </label>
            <label>
              Nachname
              <input {...feld("nachname")} autoComplete="family-name" required />
            </label>
            <label className="breit">
              Firma (optional)
              <input {...feld("firma")} autoComplete="organization" />
            </label>
            <label className="breit">
              Straße und Hausnummer
              <input {...feld("strasse")} autoComplete="address-line1" required />
            </label>
            <label className="breit">
              Adresszusatz (optional)
              <input {...feld("zusatz")} autoComplete="address-line2" />
            </label>
            <label className="plz">
              PLZ
              <input {...feld("plz")} autoComplete="postal-code" required />
            </label>
            <label>
              Ort
              <input {...feld("ort")} autoComplete="address-level2" required />
            </label>
            <label>
              Land
              <select {...feld("land")} autoComplete="country">
                {status.laender.map((l) => (
                  <option key={l.iso} value={l.iso}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : (
          <div className="kasse-zeile">
            <span>
              {adresse.vorname} {adresse.nachname}
              {adresse.firma ? `, ${adresse.firma}` : ""}, {adresse.strasse}, {adresse.plz}{" "}
              {adresse.ort}, {status.laender.find((l) => l.iso === adresse.land)?.name ?? adresse.land}
            </span>
            <button type="button" className="btn quiet small" onClick={() => setAdresseOffen(true)}>
              Ändern
            </button>
          </div>
        )}
      </section>

      <section className="kasse-teil">
        <h4>Zahlung</h4>
        {zahlweise === "gespeichert" && status.karte ? (
          <div className="kasse-zeile">
            <span>
              {status.karte.name}
              {status.karte.ablauf ? `, gültig bis ${status.karte.ablauf}` : ""}
            </span>
            <button type="button" className="btn quiet small" onClick={() => setNeueKarte(true)}>
              Andere Karte
            </button>
          </div>
        ) : (
          <>
            {angebot && (
              <KartenFeld
                publishableKey={status.publishableKey}
                betragCents={angebot.betragCents}
                speichern={speichern}
                onBereit={(k) => {
                  karte.current = k;
                  setKarteBereit(k !== null);
                }}
              />
            )}
            <label className="consent">
              <input type="checkbox" checked={speichern} onChange={(e) => setSpeichern(e.target.checked)} />
              <span>Karte für spätere Käufe speichern (im Konto jederzeit entfernbar).</span>
            </label>
            {status.karte && (
              <button type="button" className="btn quiet small" onClick={() => setNeueKarte(false)}>
                Doch {status.karte.name} verwenden
              </button>
            )}
          </>
        )}
      </section>

      <div className="kasse-summe">
        {angebot ? (
          <>
            <span>Gesamt</span>
            <strong>{formatEuro(angebot.betragCents)}</strong>
            <span className="hint">{steuerText}, Digitalausgabe ohne Versand</span>
          </>
        ) : angebotFehler ? (
          <div className="err">{angebotFehler}</div>
        ) : (
          <span className="hint">Preis wird im Shop abgefragt …</span>
        )}
      </div>

      <label className="consent">
        <input type="checkbox" checked={verzicht} onChange={(e) => setVerzicht(e.target.checked)} />
        <span>
          {waiver?.text ??
            "Ich verlange ausdrücklich, dass Sie vor Ablauf der Widerrufsfrist mit der Ausführung des Vertrags beginnen. Mir ist bekannt, dass ich mit vollständiger Vertragserfüllung mein Widerrufsrecht verliere."}{" "}
          (<Link to="/widerruf">Widerrufsbelehrung</Link>)
        </span>
      </label>

      {err && <div className="err">{err}</div>}

      <button className="btn kasse-kaufen" onClick={kaufen} disabled={!bereit} aria-busy={busy}>
        {busy ? "Zahlung läuft …" : knopf}
      </button>
      <p className="hint">
        Verkäufer ist Lesen &amp; Schenken (lesenundschenken.de), dort entsteht Ihre Bestellung mit
        Rechnung. Es gelten die <Link to="/agb">AGB</Link> und die{" "}
        <Link to="/datenschutz">Datenschutzerklärung</Link>. Die Karte verarbeitet Stripe.
      </p>
      <ShopLink href={shopKasse} />
    </div>
  );
}

/** Kartenfeld (Stripe Payment Element, nur Karte samt Apple Pay und Google Pay). */
function KartenFeld({
  publishableKey,
  betragCents,
  speichern,
  onBereit,
}: {
  publishableKey: string;
  betragCents: number;
  speichern: boolean;
  onBereit: (k: { stripe: Stripe; elements: StripeElements } | null) => void;
}) {
  const ort = useRef<HTMLDivElement>(null);
  const elementsRef = useRef<StripeElements | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);

  useEffect(() => {
    let weg = false;
    let aufraeumen: (() => void) | null = null;
    stripeLaden(publishableKey)
      .then((stripe) => {
        if (weg || !stripe || !ort.current) return;
        const elements = stripe.elements({
          mode: "payment",
          amount: betragCents,
          currency: "eur",
          paymentMethodTypes: ["card"],
          setupFutureUsage: speichern ? "on_session" : null,
          locale: "de",
          appearance: STRIPE_AUSSEHEN,
        });
        const el = elements.create("payment", {
          layout: "tabs",
          // Link (Stripes eigene Schnellkasse) wuerde Kunden eine zweite Anmeldung anbieten.
          wallets: { applePay: "auto", googlePay: "auto", link: "never" },
          fields: { billingDetails: { name: "never", email: "never", address: "never" } },
          terms: { card: "never" },
        });
        el.mount(ort.current);
        el.on("ready", () => onBereit({ stripe, elements }));
        elementsRef.current = elements;
        aufraeumen = () => {
          el.destroy();
          onBereit(null);
        };
      })
      .catch(() => setFehler("Das Kartenfeld ließ sich nicht laden. Bitte die Seite neu laden."));
    return () => {
      weg = true;
      aufraeumen?.();
      elementsRef.current = null;
    };
    // Nur beim ersten Anzeigen aufbauen; Betrag und Speichern gehen per update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishableKey]);

  useEffect(() => {
    elementsRef.current?.update({
      amount: betragCents,
      setupFutureUsage: speichern ? "on_session" : null,
    });
  }, [betragCents, speichern]);

  return (
    <div className="kasse-karte">
      <div ref={ort} />
      {fehler && <div className="err">{fehler}</div>}
    </div>
  );
}

/** Nach dem Bezahlen: Bestellung im Shop und Freischaltung abwarten. */
function KaufStand({
  kaufId,
  leseZiel,
  onFertig,
  onNeu,
}: {
  kaufId: Id<"leserKaeufe">;
  leseZiel?: string;
  onFertig?: () => void;
  onNeu: () => void;
}) {
  const stand = useQuery(api.leserKasse.kaufStatus, { kaufId });
  const gemeldet = useRef(false);

  useEffect(() => {
    if (stand?.freigeschaltet && !gemeldet.current) {
      gemeldet.current = true;
      onFertig?.();
    }
  }, [stand?.freigeschaltet, onFertig]);

  if (stand === undefined) return <div className="kasse"><p className="hint">…</p></div>;
  if (stand === null) return null;

  if (stand.freigeschaltet) {
    return (
      <div className="kasse" role="status">
        <div className="ok">
          Vielen Dank. Bezahlt und freigeschaltet
          {stand.bestellung ? `, Bestellung ${stand.bestellung}` : ""}. Die Rechnung kommt per
          E-Mail.
        </div>
        <div className="row actions">
          {leseZiel ? (
            <Link className="btn" to={leseZiel}>
              Jetzt lesen
            </Link>
          ) : (
            <Link className="btn" to="/library">
              Zur Bibliothek
            </Link>
          )}
        </div>
      </div>
    );
  }
  if (stand.status === "angelegt" || stand.status === "fehlgeschlagen") {
    return (
      <div className="kasse">
        <div className={stand.status === "fehlgeschlagen" ? "err" : "hint"}>
          {stand.status === "fehlgeschlagen"
            ? (stand.fehler ?? "Die Zahlung ist fehlgeschlagen.")
            : "Die Zahlung wird geprüft …"}
        </div>
        <button className="btn secondary" onClick={onNeu}>
          Noch einmal versuchen
        </button>
      </div>
    );
  }
  if (stand.status === "fehler") {
    return (
      <div className="kasse" role="status">
        <div className="err">
          Ihre Zahlung ist eingegangen, die Freischaltung verzögert sich. Wir prüfen das und
          schalten die Ausgabe von Hand frei. Sie müssen nichts weiter tun.
        </div>
      </div>
    );
  }
  if (stand.status === "erstattet") {
    return (
      <div className="kasse">
        <div className="hint">Dieser Kauf wurde erstattet.</div>
      </div>
    );
  }
  return (
    <div className="kasse" role="status">
      <div className="ok">
        Zahlung erhalten
        {stand.bestellung ? `, Bestellung ${stand.bestellung} angelegt` : ""}. Die Ausgabe wird
        freigeschaltet …
      </div>
    </div>
  );
}
