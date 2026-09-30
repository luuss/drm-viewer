import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatEuro } from "../lib/api";
import Icon from "../components/Icon";

/** Ein bestellbares Produkt zu einer Anzeige (articleProducts.forReader). */
export type ReaderProduct = {
  productId: number;
  name: string;
  url: string;
  priceCents: number | null;
  /** Absatz des Artikels, unter dem der Knopf steht. */
  blockOrder: number;
};

/**
 * Bestellknopf zu einer Buchanzeige. Die ganze Karte ist ein gewoehnlicher
 * Link auf die Produktseite im Laden und oeffnet immer einen neuen Tab: der
 * Leser bleibt im Heft, und weil der Tab direkt aus dem Klick entsteht, haelt
 * ihn kein Pop-up-Blocker auf.
 */
export function ShopProductLink({
  product,
  onFollow,
}: {
  product: ReaderProduct;
  onFollow?: () => void;
}) {
  return (
    <a
      className="shop-produkt"
      href={product.url}
      target="_blank"
      rel="noopener"
      onClick={onFollow}
    >
      <span className="shop-produkt-text">
        <span className="shop-produkt-name">{product.name}</span>
        {product.priceCents !== null && (
          <span className="shop-produkt-preis">{formatEuro(product.priceCents)}</span>
        )}
      </span>
      <span className="btn shop-produkt-knopf">
        <Icon name="cart" />
        Im Shop bestellen
      </span>
    </a>
  );
}

/** So lange nach dem Oeffnen nimmt die Auswahl noch keine Eingaben an. */
const ARM_MS = 350;

/**
 * Auswahl im Seitenmodus: wer auf eine Anzeige tippt, kann das Buch im Laden
 * bestellen oder den Anzeigentext lesen.
 */
export function ProductChoice({
  products,
  onRead,
  onClose,
}: {
  products: ReaderProduct[];
  onRead: () => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  // Auf dem Telefon oeffnet schon das Loslassen des Fingers die Auswahl; der
  // Klick desselben Tipps kommt erst danach und traefe den Schleier (Auswahl
  // sofort wieder zu) oder den Bestellknopf (Laden geht ungewollt auf). Die
  // Auswahl nimmt deshalb erst nach einem Augenblick Eingaben an.
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setArmed(true), ARM_MS);
    box.current?.querySelector<HTMLAnchorElement>("a.shop-produkt")?.focus();
    return () => window.clearTimeout(timer);
  }, []);

  return createPortal(
    <div
      className="frage-schleier"
      style={armed ? undefined : { pointerEvents: "none" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="frage produkt-wahl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="produkt-wahl-titel"
        ref={box}
      >
        <div className="produkt-wahl-kopf">
          <h2 id="produkt-wahl-titel">Bestellen oder lesen?</h2>
          <button className="btn quiet small" aria-label="Schließen" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="produkt-wahl-liste">
          {products.map((product) => (
            <ShopProductLink key={product.productId} product={product} onFollow={onClose} />
          ))}
        </div>
        <div className="frage-knoepfe">
          <button className="btn secondary" onClick={onRead}>
            <Icon name="book-open" />
            Text lesen
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
