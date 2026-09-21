import { useParams } from "react-router-dom";

/**
 * Rechtstexte. Die mit [...] markierten Stellen muss der Verlag ausfuellen,
 * bevor der Shop oeffentlich geht — fehlende Pflichtangaben sind abmahnfaehig.
 */
const PLACEHOLDER = "[vom Verlag ausfüllen]";

const DOCS: Record<
  string,
  { title: string; body: { h?: string; p?: string; list?: string[] }[] }
> = {
  impressum: {
    title: "Impressum",
    body: [
      { h: "Angaben gemäß § 5 DDG", p: `${PLACEHOLDER} Verlag, Straße, PLZ Ort` },
      { p: `Vertreten durch: ${PLACEHOLDER}` },
      { p: `Handelsregister: ${PLACEHOLDER}, Registergericht: ${PLACEHOLDER}` },
      { p: `Umsatzsteuer-ID gemäß § 27a UStG: ${PLACEHOLDER}` },
      { h: "Kontakt", p: `Telefon: ${PLACEHOLDER} · E-Mail: ${PLACEHOLDER}` },
      {
        h: "Redaktionell verantwortlich (§ 18 Abs. 2 MStV)",
        p: `${PLACEHOLDER}`,
      },
      {
        h: "Streitbeilegung",
        p: "Zur Teilnahme an einem Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle sind wir nicht verpflichtet und nicht bereit.",
      },
    ],
  },
  agb: {
    title: "Allgemeine Geschäftsbedingungen",
    body: [
      {
        h: "1. Geltungsbereich",
        p: "Diese Bedingungen gelten für den Verkauf digitaler Ausgaben und digitaler Abonnements über diese Plattform an Verbraucher und Unternehmer.",
      },
      {
        h: "2. Vertragsgegenstand",
        p: "Verkauft wird ein zeitlich unbegrenztes Lesezugriffsrecht auf eine einzelne digitale Ausgabe oder, im Abonnement, auf die während der Laufzeit freigegebenen Ausgaben. Ein Download der Druckdatei ist nicht Vertragsbestandteil. Der Zugriff erfolgt ausschließlich online über den Reader dieser Plattform.",
      },
      {
        h: "3. Vertragsschluss",
        p: "Mit Abschluss des Bezahlvorgangs kommt der Vertrag zustande. Die Freischaltung erfolgt unmittelbar nach Zahlungsbestätigung.",
      },
      {
        h: "4. Preise und Zahlung",
        p: "Alle Preise verstehen sich inklusive der gesetzlichen Umsatzsteuer. Die Zahlungsabwicklung erfolgt über Stripe. Es gelten die dort angebotenen Zahlungsarten.",
      },
      {
        h: "5. Abonnement und Kündigung",
        p: "Ein Abonnement verlängert sich automatisch um die gebuchte Laufzeit, solange es nicht gekündigt wird. Die Kündigung ist jederzeit zum Ende der laufenden Abrechnungsperiode über das Kundenportal im Profil möglich.",
      },
      {
        h: "6. Zahlungsverzug",
        p: "Scheitert eine wiederkehrende Zahlung, ruht der Zugriff nach einer kurzen Nachfrist, bis die Zahlung nachgeholt ist.",
      },
      {
        h: "7. Nutzungsrechte",
        p: "Der Zugang ist persönlich und nicht übertragbar. Vervielfältigung, Weitergabe der Zugangsdaten und systematisches Auslesen der Inhalte sind untersagt. Die Zahl gleichzeitiger Lesesitzungen je Konto ist technisch begrenzt.",
      },
      {
        h: "8. Verfügbarkeit",
        p: "Wir bemühen uns um durchgehende Erreichbarkeit. Kurzzeitige Unterbrechungen für Wartung bleiben vorbehalten.",
      },
      { h: "9. Anbieter", p: `${PLACEHOLDER}` },
    ],
  },
  widerruf: {
    title: "Widerrufsbelehrung",
    body: [
      {
        h: "Widerrufsrecht",
        p: "Verbraucher haben das Recht, binnen vierzehn Tagen ohne Angabe von Gründen diesen Vertrag zu widerrufen. Die Widerrufsfrist beträgt vierzehn Tage ab dem Tag des Vertragsschlusses.",
      },
      {
        h: "Ausübung des Widerrufs",
        p: `Um das Widerrufsrecht auszuüben, müssen Sie uns (${PLACEHOLDER}) mittels einer eindeutigen Erklärung über Ihren Entschluss informieren. Sie können dafür das Muster-Widerrufsformular verwenden, das aber nicht vorgeschrieben ist.`,
      },
      {
        h: "Vorzeitiges Erlöschen des Widerrufsrechts",
        p: "Bei digitalen Inhalten erlischt das Widerrufsrecht, wenn wir mit der Vertragserfüllung begonnen haben, nachdem Sie ausdrücklich zugestimmt haben, dass wir vor Ablauf der Widerrufsfrist beginnen, und Sie Ihre Kenntnis vom Verlust des Widerrufsrechts bestätigt haben. Diese Zustimmung holen wir im Bestellvorgang mit einem Häkchen ein und protokollieren sie.",
      },
      {
        h: "Folgen des Widerrufs",
        p: "Im Fall eines wirksamen Widerrufs erstatten wir alle erhaltenen Zahlungen unverzüglich und spätestens binnen vierzehn Tagen zurück.",
      },
    ],
  },
  datenschutz: {
    title: "Datenschutzerklärung",
    body: [
      {
        h: "Verantwortlicher",
        p: `${PLACEHOLDER}`,
      },
      {
        h: "Welche Daten wir verarbeiten",
        list: [
          "Kontodaten: E-Mail-Adresse, gehashtes Passwort, optionaler Anzeigename.",
          "Kaufdaten: gekaufte Ausgaben, Abostatus, Zahlungsbelege.",
          "Nutzungsdaten: Lesefortschritt, aktive Lesesitzungen, abgerufene Seitenkacheln.",
        ],
      },
      {
        h: "Zwecke und Rechtsgrundlagen",
        p: "Die Verarbeitung dient der Vertragserfüllung (Art. 6 Abs. 1 lit. b DSGVO) sowie dem Schutz vor unberechtigter Nutzung (Art. 6 Abs. 1 lit. f DSGVO).",
      },
      {
        h: "Empfänger",
        list: [
          "Stripe Payments Europe Ltd. — Zahlungsabwicklung und Rechnungen.",
          "Resend — Versand von Transaktions-E-Mails.",
          "Hosting der Anwendung und Datenbank: " + PLACEHOLDER,
        ],
      },
      {
        h: "Speicherdauer",
        p: "Kontodaten bis zur Löschung des Kontos. Kaufbelege für die gesetzliche Aufbewahrungsfrist von zehn Jahren. Lesesitzungen werden nach wenigen Stunden automatisch gelöscht.",
      },
      {
        h: "Ihre Rechte",
        p: "Auskunft, Berichtigung, Löschung, Einschränkung, Datenübertragbarkeit und Widerspruch. Das Konto lässt sich im Profil selbst löschen. Zudem besteht ein Beschwerderecht bei einer Aufsichtsbehörde.",
      },
      {
        h: "Kopierschutz",
        p: "Die Seiten werden als Einzelkacheln mit sitzungsbezogener Kennzeichnung ausgeliefert. Dabei fallen technische Protokolldaten an, die der Missbrauchserkennung dienen.",
      },
    ],
  },
};

export default function LegalPage({ doc }: { doc?: string }) {
  const params = useParams();
  const key = doc ?? params.doc ?? window.location.pathname.replace(/^\//, "");
  const entry = DOCS[key] ?? null;
  if (!entry) return <div className="centered">Dokument nicht gefunden</div>;

  return (
    <div className="page legal">
      <div className="page-head">
        <h2>{entry.title}</h2>
      </div>
      {entry.body.map((sec, i) => (
        <div className="legal-section" key={i}>
          {sec.h && <h3>{sec.h}</h3>}
          {sec.p && <p>{sec.p}</p>}
          {sec.list && (
            <ul>
              {sec.list.map((li, j) => (
                <li key={j}>{li}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
