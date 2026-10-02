import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";

/**
 * Rechtstexte des Lesers. Wo die Lage dieselbe ist wie im Netzladen
 * (Anbieter, Hosting, Cloudflare, Rechte, Speicherfristen), folgt der Wortlaut
 * dessen CMS-Seiten (lesenundschenken.de/content/2-impressum, 3-agb,
 * 6-datenschutz, 7-widerrufsbelehrung); bei Aenderungen dort hier nachziehen.
 * Eigen sind die Teile, die digitale Inhalte betreffen: Widerruf nach
 * § 356 Abs. 5 BGB, Kasse mit Stripe-Kartenfeld, Konto, Lesesitzungen.
 */

const SHOP = "https://lesenundschenken.de";
/** Nimmt Widerrufe entgegen und bestaetigt dem Kunden den Eingang per Mail. */
const WIDERRUF_ZIEL = `${SHOP}/widerruf-senden.php`;

type Section = { h?: string; p?: ReactNode; lines?: string[]; list?: ReactNode[] };

const ext = (href: string, text: string) => (
  <a href={href} target="_blank" rel="noopener noreferrer">
    {text}
  </a>
);

const ANBIETER = [
  "Lesen & Schenken Verlagsauslieferung und Versandgesellschaft mbH",
  "Voßkumsberg 4",
  "D-24238 Martensrade",
];

const DOCS: Record<string, { title: string; body: Section[]; form?: "widerruf" }> = {
  impressum: {
    title: "Impressum",
    body: [
      { lines: ANBIETER },
      {
        lines: [
          "Telefon: 04384 59700 · Telefax: 04384 597040",
          "E-Mail: buchversand@lesenundschenken.de",
          "Geschäftsführer: Dietmar Munier",
          "HRB Kiel 1827 PL",
          "USt.-IdNr.: DE 134818565",
        ],
      },
      { h: "Verantwortlich für den Inhalt dieser Seiten", p: "Dietmar Munier" },
      {
        h: "Jugendschutzbeauftragter gemäß § 7 JMStV",
        lines: ["Rechtsanwalt Laurens Notdurft", "Am Fischtal 76c, 14169 Berlin"],
      },
      {
        h: "Für alle externen Links gilt",
        p: "Wir betonen ausdrücklich, daß wir keinerlei Einfluß auf die Gestaltung und die Inhalte der gelinkten Seiten haben. Deshalb distanzieren wir uns hiermit vorsorglich von allen Inhalten aller gelinkten Seiten auf dieser Homepage und machen uns ihre Inhalte nicht zu eigen. Wir weisen ausdrücklich darauf hin, daß alle Seiten fremder Autoren, auf die in den von uns erstellten und hier abrufbaren Seiten verwiesen wird, nicht in unserem Verantwortungsbereich liegen. Die Erstellung der Verweise zu Seiten anderer Personen geschieht unter Vorbehalt, da wir nicht alle Verweise regelmäßig auf Gesetzesübertretungen überprüfen können. Falls unsere Seiten auf Seiten verweisen, deren Inhalt nach deutschem oder europäischem Recht strafbar ist, so distanzieren wir uns ausdrücklich gemäß Entscheidung des BGH vom 30.01.1996.",
      },
    ],
  },

  agb: {
    title: "Allgemeine Geschäftsbedingungen",
    body: [
      {
        p: "Allgemeine Geschäftsbedingungen der Lesen & Schenken Verlagsauslieferung und Versandgesellschaft mbH für digitale Ausgaben im Leser (lesen.lesenundschenken.de)",
      },
      {
        h: "§ 1 Geltungsbereich und Begriffsdefinitionen",
        p: (
          <>
            (1) Die nachfolgenden Allgemeinen Geschäftsbedingungen gelten für alle Verträge über
            digitale Ausgaben, die zwischen uns und einem Verbraucher über den Leser unter
            lesen.lesenundschenken.de geschlossen werden, in ihrer zum Zeitpunkt der Bestellung
            gültigen Fassung. Sie gelten außerdem für das Lesen digitaler Ausgaben und
            Digital-Abos, die im Netzladen unter lesenundschenken.de gekauft wurden; für die
            Bestellung im Netzladen gelten dessen {ext(`${SHOP}/content/3-agb`, "AGB")}.
            <br />
            (2) Verbraucher ist jede natürliche Person, die ein Rechtsgeschäft zu Zwecken
            abschließt, die überwiegend weder ihrer gewerblichen noch ihrer selbständigen
            beruflichen Tätigkeit zugerechnet werden können (§ 13 BGB).
          </>
        ),
      },
      {
        h: "§ 2 Zustandekommen eines Vertrages, Speicherung des Vertragstextes",
        p: "(1) Im Falle des Vertragsschlusses kommt der Vertrag zustande mit:",
      },
      { lines: [...ANBIETER, "HRB Kiel 1827 PL", "USt.-IdNr.: DE134818565"] },
      {
        p: "(2) Die Präsentation der Ausgaben im Leser stellt kein rechtlich bindendes Vertragsangebot unsererseits dar, sondern ist nur eine unverbindliche Aufforderung an den Verbraucher, Ausgaben zu bestellen. Die Bestellung erfolgt in folgenden Schritten:",
        list: [
          "Auswahl der gewünschten Ausgabe und Anklicken von „Jetzt kaufen“, oder Sammeln mehrerer Ausgaben im Warenkorb.",
          "Anmeldung mit der E-Mail-Adresse über den zugesandten Anmeldelink.",
          "Eingabe der Rechnungsadresse (beim ersten Kauf).",
          "Eingabe der Kartendaten oder Auswahl der gespeicherten Karte.",
          "Ausdrückliche Zustimmung zum Beginn der Vertragsausführung vor Ablauf der Widerrufsfrist für die Digitalausgaben dieses Kaufs (siehe § 6).",
          "Verbindliche Absendung der Bestellung durch Anklicken des Buttons „Jetzt zahlungspflichtig kaufen“.",
        ],
      },
      {
        p: "(3) Mit dem Anklicken von „Jetzt zahlungspflichtig kaufen“ gibt der Verbraucher ein für ihn verbindliches Angebot ab. Bis dahin kann er seine Angaben jederzeit prüfen und berichtigen oder den Bestellvorgang durch Schließen des Browserfensters abbrechen. Wir nehmen das Angebot an, indem wir die Ausgabe freischalten oder den Eingang der Bestellung per E-Mail bestätigen, je nachdem, was zuerst geschieht.",
      },
      {
        p: (
          <>
            (4) Speicherung des Vertragstextes: Wir senden dem Verbraucher die Bestelldaten mit der
            Bestellbestätigung und der Rechnung per E-Mail zu. Die AGB kann der Verbraucher
            jederzeit unter <Link to="/agb">lesen.lesenundschenken.de/agb</Link> einsehen. Die
            gekauften Ausgaben stehen in der Bibliothek seines Kontos.
          </>
        ),
      },
      {
        h: "§ 3 Preise, Zahlung, Fälligkeit",
        p: (
          <>
            (1) Die angegebenen Preise enthalten die gesetzliche Umsatzsteuer und sonstige
            Preisbestandteile. Versandkosten fallen nicht an.
            <br />
            (2) Im Leser erfolgt die Zahlung per Kreditkarte, auch über Apple Pay oder Google Pay.
            Die Zahlung wickelt der Zahlungsdienstleister Stripe ab. Der Kaufpreis ist mit
            Vertragsschluss fällig und wird sofort belastet. Andere Zahlarten bietet der{" "}
            {ext(SHOP, "Netzladen")} an.
          </>
        ),
      },
      {
        h: "§ 4 Bereitstellung",
        p: "(1) Die gekaufte Ausgabe wird unmittelbar nach Zahlungseingang im Konto des Verbrauchers freigeschaltet. Gelesen wird online im Browser über den Leser; ein Download der Ausgabe oder der Druckdatei ist nicht Vertragsbestandteil. (2) Voraussetzung sind eine Internetverbindung und ein aktueller Browser.",
      },
      {
        h: "§ 5 Nutzungsrechte",
        p: "(1) Der Verbraucher erhält an einer gekauften Ausgabe ein zeitlich unbegrenztes, einfaches und nicht übertragbares Recht, sie für persönliche Zwecke im Leser zu lesen; im Digital-Abo gilt dies für die während der Laufzeit freigegebenen Ausgaben. (2) Vervielfältigung, Weitergabe der Zugangsdaten und systematisches Auslesen der Inhalte sind untersagt. Ein Konto kann in höchstens zwei Browsern zugleich angemeldet sein. Die Seiten tragen ein sichtbares Wasserzeichen mit der Kennung des Kontos.",
      },
      {
        h: "§ 6 Widerrufsrecht",
        p: (
          <>
            Verbrauchern steht ein Widerrufsrecht nach Maßgabe der{" "}
            <Link to="/widerruf">Widerrufsbelehrung</Link> zu. Es erlischt, wenn wir mit der
            Ausführung des Vertrags begonnen haben, nachdem der Verbraucher ausdrücklich zugestimmt
            hat, dass wir vor Ablauf der Widerrufsfrist beginnen, und seine Kenntnis davon bestätigt
            hat, dass er durch seine Zustimmung mit Beginn der Ausführung sein Widerrufsrecht
            verliert.
          </>
        ),
      },
      {
        h: "§ 7 Digital-Abos",
        p: "Digital-Abos werden im Netzladen abgeschlossen. Laufzeit, Verlängerung und Kündigung richten sich nach den dort bei der Bestellung genannten Bedingungen.",
      },
      {
        h: "§ 8 Gewährleistung",
        p: "Es gelten die gesetzlichen Gewährleistungsregelungen, für digitale Produkte die §§ 327 ff. BGB.",
      },
      {
        h: "§ 9 Verfügbarkeit",
        p: "Wir bemühen uns um durchgehende Erreichbarkeit des Lesers. Kurzzeitige Unterbrechungen für Wartung bleiben vorbehalten.",
      },
      { h: "§ 10 Vertragssprache", p: "Als Vertragssprache steht ausschließlich Deutsch zur Verfügung." },
    ],
  },

  widerruf: {
    title: "Widerrufsbelehrung",
    form: "widerruf",
    body: [
      {
        h: "Widerrufsrecht",
        p: "Sie haben das Recht, binnen vierzehn Tagen ohne Angabe von Gründen diesen Vertrag zu widerrufen. Die Widerrufsfrist beträgt vierzehn Tage ab dem Tag des Vertragsabschlusses. Um Ihr Widerrufsrecht auszuüben, müssen Sie uns",
      },
      {
        lines: [
          ...ANBIETER,
          "E-Mail: buchversand@lesenundschenken.de",
          "Telefax: 04384 597040",
        ],
      },
      {
        p: "mittels einer eindeutigen Erklärung (z. B. ein mit der Post versandter Brief, Telefax oder E-Mail) über Ihren Entschluss, diesen Vertrag zu widerrufen, informieren. Sie können dafür das nachstehende Formular verwenden, das jedoch nicht vorgeschrieben ist. Zur Wahrung der Widerrufsfrist reicht es aus, dass Sie die Mitteilung über die Ausübung des Widerrufsrechts vor Ablauf der Widerrufsfrist absenden.",
      },
      {
        h: "Widerrufsfolgen",
        p: "Wenn Sie diesen Vertrag widerrufen, haben wir Ihnen alle Zahlungen, die wir von Ihnen erhalten haben, unverzüglich und spätestens binnen vierzehn Tagen ab dem Tag zurückzuzahlen, an dem die Mitteilung über Ihren Widerruf dieses Vertrags bei uns eingegangen ist. Für diese Rückzahlung verwenden wir dasselbe Zahlungsmittel, das Sie bei der ursprünglichen Transaktion eingesetzt haben, es sei denn, mit Ihnen wurde ausdrücklich etwas anderes vereinbart; in keinem Fall werden Ihnen wegen dieser Rückzahlung Entgelte berechnet.",
      },
      {
        h: "Vorzeitiges Erlöschen des Widerrufsrechts",
        p: "Ihr Widerrufsrecht erlischt, wenn wir mit der Ausführung des Vertrags begonnen haben, nachdem Sie ausdrücklich zugestimmt haben, dass wir vor Ablauf der Widerrufsfrist mit der Ausführung des Vertrags beginnen, und Sie Ihre Kenntnis davon bestätigt haben, dass Sie durch Ihre Zustimmung mit Beginn der Ausführung des Vertrags Ihr Widerrufsrecht verlieren. Diese Zustimmung holen wir in der Kasse vor jedem Kauf ein und bestätigen sie Ihnen mit der Bestellbestätigung.",
      },
      { p: "Ende der Widerrufsbelehrung" },
    ],
  },

  datenschutz: {
    title: "Datenschutzerklärung",
    body: [
      {
        p: "Wir freuen uns über Ihr Interesse an unserem Online-Angebot. Der Schutz Ihrer Privatsphäre ist für uns sehr wichtig. Nachstehend informieren wir Sie ausführlich über den Umgang mit Ihren Daten.",
      },
      {
        h: "1. Anwendungsbereich und Verantwortliche",
        p: (
          <>
            Diese Datenschutzerklärung informiert die Nutzer („Sie“) über die Art, den Umfang und
            die Zwecke der Erhebung und Verwendung personenbezogener Daten im Leser unter
            lesen.lesenundschenken.de (im Folgenden „Leser“), in dem Sie digitale Ausgaben kaufen
            und lesen. Ihre Käufe werden als Bestellung im Netzladen unter lesenundschenken.de
            gebucht; für den Netzladen gilt dessen{" "}
            {ext(`${SHOP}/content/6-datenschutz`, "Datenschutzerklärung")}. Verantwortliche Stelle
            ist:
          </>
        ),
      },
      {
        lines: [
          "Lesen & Schenken GmbH",
          "Voßkumsberg 4",
          "24238 Martensrade",
          "E-Post: datenschutz@lesenundschenken.de",
          "Telefon: 04384/5970-0",
          "Telefax: 04384/5970-40",
        ],
      },
      {
        p: "Das genannte Unternehmen („wir“) handelt dabei als Verantwortlicher im Sinne der datenschutzrechtlichen Vorschriften.",
      },
      {
        h: "2. Datenschutzbeauftragter",
        lines: [
          "Lesen & Schenken GmbH",
          "Datenschutzbeauftragter",
          "Voßkumsberg 4",
          "24238 Martensrade",
          "E-Post: datenschutz@lesenundschenken.de",
        ],
      },
      {
        h: "3. Zugriffsdaten und Hosting",
        p: "Bei jedem Aufruf speichert der Webserver automatisch ein sogenanntes Server-Logfile, das z. B. den Namen der angeforderten Datei, Ihre IP-Adresse, Datum und Uhrzeit des Abrufs, übertragene Datenmenge und den anfragenden Provider (Zugriffsdaten) enthält und den Abruf dokumentiert. Diese Zugriffsdaten werden ausschließlich zum Zwecke der Sicherstellung eines störungsfreien Betriebs sowie der Verbesserung unseres Angebots ausgewertet. Rechtsgrundlage ist Art. 6 Abs. 1 S. 1 lit. f DSGVO; unser berechtigtes Interesse besteht im sicheren und störungsfreien Betrieb sowie in der korrekten Darstellung unseres Online-Angebots. Die Server-Logfiles werden im Rahmen der üblichen Logrotation gelöscht. Der Leser läuft auf demselben Server wie der Netzladen; diesen betreibt in unserem Auftrag ein Hosting-Dienstleister mit Sitz in der Europäischen Union oder im Europäischen Wirtschaftsraum.",
      },
      {
        h: "Auslieferung und Schutz durch Cloudflare",
        p: (
          <>
            Der Leser wird wie der Netzladen über das Netzwerk der Cloudflare, Inc., 101 Townsend
            St., San Francisco, CA 94107, USA („Cloudflare“) ausgeliefert. Cloudflare steht als
            sogenannter Reverse-Proxy zwischen Ihrem Browser und unserem Server und verarbeitet
            dabei die Zugriffsdaten Ihres Aufrufs, insbesondere Ihre IP-Adresse, Datum und Uhrzeit,
            die aufgerufene Adresse, Angaben zu Browser und Betriebssystem sowie die zuvor besuchte
            Seite. Die verschlüsselte Verbindung Ihres Browsers endet bei Cloudflare und wird von
            dort verschlüsselt zu unserem Server weitergeführt; deshalb laufen auch Ihre Angaben im
            Leser durch das Netzwerk von Cloudflare. Zweck ist der Schutz vor Angriffen und
            automatisierten Massenabrufen, die Sicherstellung der Erreichbarkeit sowie kürzere
            Ladezeiten. Rechtsgrundlage ist Art. 6 Abs. 1 S. 1 lit. f DSGVO. Cloudflare wird für
            uns als Auftragsverarbeiter nach Art. 28 DSGVO tätig. Nur wenn eine Anfrage auffällig
            ist, kann Cloudflare eine Sicherheitsabfrage anzeigen und danach ein technisch
            notwendiges Cookie („cf_clearance“) setzen (§ 25 Abs. 2 Nr. 2 TDDDG). Cloudflare, Inc.
            ist nach dem EU-US Data Privacy Framework zertifiziert (Art. 45 DSGVO); zusätzlich
            gelten Standardvertragsklauseln der EU-Kommission (Art. 46 Abs. 2 lit. c DSGVO).
            Weitere Informationen: {ext("https://www.cloudflare.com/de-de/privacypolicy/", "Datenschutzerklärung von Cloudflare")}.
          </>
        ),
      },
      {
        h: "4. Konto und Anmeldung",
        p: "Zum Lesen und Kaufen melden Sie sich mit Ihrer E-Mail-Adresse an. Wir schicken Ihnen einen Anmeldelink, der 15 Minuten und einmal gilt; ein Passwort gibt es nicht. Den Link versendet der Mailserver des Netzladens. Gespeichert werden:",
        list: [
          "Ihre E-Mail-Adresse und auf Wunsch ein Anzeigename,",
          "zum Anmeldelink nur ein Prüfwert sowie Ihre IP-Adresse, um Missbrauch zu begrenzen; beides löschen wir nach einem Tag,",
          "zu jeder Anmeldung eine Gerätebezeichnung (Browser und Betriebssystem), damit Sie im Konto sehen und beenden können, wo Sie angemeldet sind.",
        ],
      },
      {
        p: "Rechtsgrundlage ist Art. 6 Abs. 1 S. 1 lit. b DSGVO (Bereitstellung des Kontos), für die Missbrauchsbegrenzung Art. 6 Abs. 1 S. 1 lit. f DSGVO.",
      },
      {
        h: "5. Kauf im Leser",
        p: "Wenn Sie im Leser eine Ausgabe kaufen, verarbeiten wir Ihre Rechnungsadresse (Name, ggf. Firma, Anschrift, Land), Ihre E-Mail-Adresse, die gekauften Ausgaben und den Zeitpunkt Ihrer Zustimmung zum vorzeitigen Beginn der Vertragsausführung (Widerrufsverzicht) mit deren Wortlaut. Mit diesen Angaben legen wir die Bestellung im Netzladen an, der die Rechnung erstellt und Ihnen Bestellbestätigung und Rechnung per E-Mail schickt. Käufe aus dem Netzladen meldet uns dieser mit Bestellnummer, Kundennummer, E-Mail-Adresse und Artikeln, damit wir die Ausgaben in Ihrem Konto freischalten. Rechtsgrundlage ist Art. 6 Abs. 1 S. 1 lit. b DSGVO, für die Aufbewahrung der Belege Art. 6 Abs. 1 S. 1 lit. c DSGVO.",
      },
      {
        h: "Kartenzahlung über Stripe",
        p: (
          <>
            Die Kartenzahlung (auch Apple Pay und Google Pay) wickeln wir über Stripe Payments
            Europe, Limited, The One Building, 1 Grand Canal Street Lower, Dublin 2, D02 H210,
            Irland („Stripe“) ab. Das Kartenfeld in der Kasse stammt von Stripe: Ihre Kartendaten
            geben Sie direkt bei Stripe ein, sie erreichen unseren Server nicht. Wir übermitteln
            Stripe Betrag, Bestellbezug und Ihre E-Mail-Adresse und erhalten das Ergebnis der
            Zahlung. Speichern Sie Ihre Karte für spätere Käufe, legt Stripe für Sie ein
            Kundenprofil an; wir speichern davon nur Kartenmarke, die letzten vier Ziffern und das
            Ablaufdatum. Die Karte können Sie im Konto unter „Zahlungsdaten“ jederzeit entfernen.
            <br />
            In der Kasse lädt Ihr Browser ein Skript von js.stripe.com. Stripe setzt dabei Cookies
            (u. a. „__stripe_mid“, Laufzeit ein Jahr, und „__stripe_sid“, Laufzeit 30 Minuten) und
            wertet Angaben zu Ihrem Gerät und Browser aus, um Kartenbetrug zu erkennen. Das
            geschieht nur in der Kasse. Die Speicherung erfolgt nach § 25 Abs. 2 Nr. 2 TDDDG, weil
            sie für die von Ihnen gewünschte Kartenzahlung unbedingt erforderlich ist.
            <br />
            Rechtsgrundlage ist Art. 6 Abs. 1 S. 1 lit. b DSGVO (Zahlungsabwicklung) sowie Art. 6
            Abs. 1 S. 1 lit. f DSGVO; unser berechtigtes Interesse liegt im Schutz vor
            Zahlungsbetrug. Stripe verarbeitet Daten teilweise auch als eigener Verantwortlicher,
            etwa zur Erfüllung gesetzlicher Pflichten und zur Betrugsverhinderung. Dabei können
            Daten an Stripe, Inc. in den USA übermittelt werden. Stripe, Inc. ist nach dem EU-US
            Data Privacy Framework zertifiziert (Art. 45 DSGVO); zusätzlich gelten
            Standardvertragsklauseln der EU-Kommission (Art. 46 Abs. 2 lit. c DSGVO). Weitere
            Informationen: {ext("https://stripe.com/de/privacy", "Datenschutzerklärung von Stripe")}.
          </>
        ),
      },
      {
        h: "6. Lesen und Kopierschutz",
        p: "Beim Lesen speichern wir Ihren Lesefortschritt, damit Sie an der zuletzt gelesenen Stelle weiterlesen können. Zu jedem geöffneten Heft legen wir eine kurzlebige Lesesitzung an (Konto, Ausgabe, Zeitpunkte, Zahl der abgerufenen Seitenteile); ein Konto kann in höchstens zwei Browsern zugleich angemeldet sein. Die Seiten zeigen ein dezentes Wasserzeichen mit Ihrer E-Mail-Adresse. Das dient dem Schutz der Inhalte vor unberechtigter Weitergabe. Rechtsgrundlage ist Art. 6 Abs. 1 S. 1 lit. b DSGVO, für den Kopierschutz Art. 6 Abs. 1 S. 1 lit. f DSGVO; unser berechtigtes Interesse liegt im Schutz der Verlagsinhalte. Abgelaufene Lesesitzungen löschen wir beim nächsten Öffnen eines Hefts, spätestens mit dem Konto.",
      },
      {
        h: "7. Cookies und Speicher im Browser",
        p: "Der Leser selbst setzt keine Cookies. Er legt im Speicher Ihres Browsers (Local Storage) nur ab, was für den von Ihnen gewünschten Dienst nötig ist: die Anmeldung, den Inhalt des Warenkorbs und die gewählte Seitenansicht. Zu Cloudflare und Stripe siehe oben. Statistik-, Werbe- oder Analysedienste setzen wir nicht ein; die Schriften liegen auf unserem eigenen Server. Die Speicherung erfolgt nach § 25 Abs. 2 Nr. 2 TDDDG, weil sie für den von Ihnen gewünschten Dienst unbedingt erforderlich ist.",
      },
      {
        h: "8. Datenlöschung und Speicherdauer",
        p: "Sofern nicht anders gekennzeichnet, werden Ihre personenbezogenen Daten gelöscht oder gesperrt, sobald der Zweck der Speicherung entfällt. Ihr Konto können Sie im Profil selbst löschen; Rechnungsadresse und gespeicherte Karte werden dabei mit entfernt. Aufbewahrungspflichten ergeben sich aus Vorschriften der Rechnungslegung (§ 257 HGB) und aus steuerrechtlichen Vorschriften (§ 147 AO sowie § 14b UStG). Gemäß diesen Vorschriften sind geschäftliche Kommunikation, geschlossene Verträge und Buchungsbelege bis zu 10 Jahren aufzubewahren. Soweit wir diese Daten nicht mehr zur Durchführung der Dienstleistungen für Sie benötigen, werden sie gesperrt und nur noch für Zwecke der Rechnungslegung und für Steuerzwecke verwendet.",
      },
      {
        h: "9. Ihre Rechte als betroffene Person",
        p: "Bei Vorliegen der gesetzlichen Voraussetzungen haben Sie das Recht, bei uns Auskunft über Sie betreffende personenbezogene Daten bzw. Datenverarbeitungen (Art. 15 DSGVO), Berichtigung, Löschung und Einschränkung Sie betreffender personenbezogener Daten bzw. Datenverarbeitungen (Art. 16 bis 18 DSGVO) und Übertragung Sie betreffender personenbezogener Daten (Art. 20 DSGVO) zu verlangen. Außerdem steht Ihnen bei Vorliegen der gesetzlichen Voraussetzungen nach Art. 21 DSGVO ein Widerspruchsrecht gegen Datenverarbeitungen zu, die auf einem „berechtigten Interesse“ des Verantwortlichen gemäß Art. 6 Abs. 1 lit. f DSGVO beruhen. Sie haben das Recht, eine datenschutzrechtliche Einwilligungserklärung jederzeit zu widerrufen. Durch den Widerruf der Einwilligung wird die Rechtmäßigkeit der aufgrund der Einwilligung bis zum Widerruf erfolgten Verarbeitung nicht berührt.",
      },
      {
        h: "10. Recht auf Beschwerde bei einer Aufsichtsbehörde",
        p: "Sie haben gemäß Art. 77 Abs. 1 DSGVO das Recht, sich bei der Aufsichtsbehörde zu beschweren, wenn Sie der Ansicht sind, dass die Verarbeitung Ihrer personenbezogenen Daten nicht rechtmäßig erfolgt, insbesondere gegen die DSGVO verstößt. In der Regel können Sie sich hierfür an die Aufsichtsbehörde Ihres üblichen Aufenthaltsortes oder Arbeitsplatzes oder unseres Unternehmenssitzes wenden.",
      },
    ],
  },
};

/**
 * Widerrufsfunktion (§ 356a BGB). Geht an dasselbe Skript wie das Formular im
 * Netzladen; es leitet den Widerruf an den Verlag und bestaetigt dem Kunden den
 * Eingang per E-Mail.
 */
function WiderrufFormular() {
  const me = useQuery(api.users.me, {});
  return (
    <div className="legal-section">
      <h3>Vertrag widerrufen</h3>
      <p>
        Wenn Sie den Vertrag widerrufen wollen, füllen Sie bitte dieses Formular aus und senden Sie
        es ab. Den Eingang bestätigen wir Ihnen umgehend per E-Mail. Eine Angabe von Gründen ist
        nicht erforderlich; Ihre Angaben verwenden wir ausschließlich zur Bearbeitung des
        Widerrufs.
      </p>
      <form className="stack-form" method="post" action={WIDERRUF_ZIEL}>
        <input
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          style={{ position: "absolute", left: "-9999px", width: 1, height: 1 }}
        />
        <label>
          Name *
          <input name="name" autoComplete="name" required maxLength={120} />
        </label>
        <label>
          E-Mail-Adresse *
          <input
            type="email"
            name="email"
            autoComplete="email"
            required
            maxLength={160}
            defaultValue={me?.email ?? ""}
            key={me?.email ?? ""}
          />
        </label>
        <label>
          Anschrift
          <textarea name="anschrift" rows={3} autoComplete="street-address" maxLength={400} />
        </label>
        <label>
          Bestell- oder Rechnungsnummer
          <input name="rechnungsnummer" maxLength={60} />
        </label>
        <label>
          Bestellt am
          <input name="bestellt_am" placeholder="TT.MM.JJJJ" maxLength={60} />
        </label>
        <label>
          Hiermit widerrufe(n) ich/wir den abgeschlossenen Vertrag über folgende digitale Ausgaben *
          <textarea name="waren" rows={4} required maxLength={1500} />
        </label>
        <button type="submit" className="btn">
          Widerruf bestätigen
        </button>
      </form>
    </div>
  );
}

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
          {sec.lines && (
            <p>
              {sec.lines.map((l, j) => (
                <span key={j}>
                  {l}
                  <br />
                </span>
              ))}
            </p>
          )}
          {sec.list && (
            <ul>
              {sec.list.map((li, j) => (
                <li key={j}>{li}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {entry.form === "widerruf" && <WiderrufFormular />}
    </div>
  );
}
