/**
 * Verkauft wird im Laden auf lesenundschenken.de. Die Freischaltung haengt an
 * der E-Mail-Adresse der Bestellung und greift auch fuer ein Konto, das erst
 * nach dem Kauf angelegt wird.
 */
export const SHOP_HINWEIS =
  "Gekauft im Shop? Mit derselben E-Mail anmelden, dann ist das Heft freigeschaltet.";

export default function ShopHinweis({ className = "hint" }: { className?: string }) {
  return <p className={`${className} shop-hint`}>{SHOP_HINWEIS}</p>;
}
