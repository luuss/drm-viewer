import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../lib/convex";

export default function AdminPlans() {
  const plans = useQuery(api.plans.listAll, {});
  const createPlan = useAction(api.billing.createPlanWithPrice);
  const setActive = useMutation(api.plans.setActive);

  const [name, setName] = useState("Jahresabo");
  const [price, setPrice] = useState("59.00");
  const [interval, setInterval] = useState<"month" | "year">("year");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <section>
      <h3>Abo-Pläne</h3>
      <form
        className="inline-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          setBusy(true);
          try {
            await createPlan({
              name,
              priceCents: Math.round(parseFloat(price) * 100),
              interval,
            });
          } catch (e: any) {
            setErr(e?.message ?? "Fehler");
          } finally {
            setBusy(false);
          }
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} required />
        <input
          type="number"
          step="0.01"
          min="0"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          required
        />
        <select
          value={interval}
          onChange={(e) => setInterval(e.target.value as "month" | "year")}
        >
          <option value="year">pro Jahr</option>
          <option value="month">pro Monat</option>
        </select>
        <button className="btn" disabled={busy}>
          {busy ? "..." : "Plan in Stripe anlegen"}
        </button>
      </form>
      {err && <div className="err">{err}</div>}

      <ul className="plain">
        {plans?.map((p) => (
          <li key={p._id}>
            {p.name} · {(p.priceCents / 100).toFixed(2)}{" "}
            {p.currency.toUpperCase()} ·{" "}
            {p.interval === "year" ? "jährlich" : "monatlich"} ·{" "}
            {p.isActive ? "aktiv" : "inaktiv"}
            <button
              className="link-btn"
              onClick={() => setActive({ planId: p._id, isActive: !p.isActive })}
            >
              {p.isActive ? "deaktivieren" : "aktivieren"}
            </button>
            <code className="hint">{p.stripePriceId}</code>
          </li>
        ))}
        {plans?.length === 0 && <li className="hint">Noch kein Plan angelegt.</li>}
      </ul>
    </section>
  );
}
