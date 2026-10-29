import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import QRCode from "qrcode";

/**
 * QR-Code der gerade offenen Seite in der Fusszeile: am Rechner mit dem Handy
 * abfotografieren, und dieselbe Seite ist dort offen. Auf schmalen Bildschirmen
 * (Handy selbst) blendet das CSS ihn aus.
 */
export default function HandyQr() {
  const loc = useLocation();
  const [svg, setSvg] = useState("");

  useEffect(() => {
    const url = window.location.origin + loc.pathname + loc.search;
    let aktiv = true;
    QRCode.toString(url, { type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#1c1c1c", light: "#ffffff" } })
      .then((s) => aktiv && setSvg(s))
      .catch(() => aktiv && setSvg(""));
    return () => {
      aktiv = false;
    };
  }, [loc.pathname, loc.search]);

  if (!svg) return null;
  return (
    <div className="footer-qr">
      <h4>Auf dem Handy öffnen</h4>
      <div className="footer-qr-zeile">
        {/* SVG kommt aus der qrcode-Bibliothek, nicht aus Nutzereingaben. */}
        <div className="footer-qr-code" dangerouslySetInnerHTML={{ __html: svg }} />
        <p>Code mit der Handykamera scannen, dann ist diese Seite dort offen.</p>
      </div>
    </div>
  );
}
