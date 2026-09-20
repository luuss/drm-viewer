import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api, TILE_SERVICE_URL, type Id } from "../lib/convex";
import AdminArticles from "./admin/AdminArticles";
import AdminPlans from "./admin/AdminPlans";

export default function AdminPage() {
  const me = useQuery(api.users.me, {});
  const books = useQuery(api.books.listAllAdmin, {});
  const genUploadUrl = useMutation(api.books.generateUploadUrl);
  const getSignedStorageUrl = useMutation(api.books.getSignedStorageUrl);
  const createBook = useMutation(api.books.createBook);
  const updateBook = useMutation(api.books.updateBook);
  const deleteBook = useMutation(api.books.deleteBook);
  const setSource = useMutation(api.books.setSourceStorageId);
  const adminGrantSelf = useMutation(api.books.adminGrantSelf);
  const ensurePrice = useAction(api.billing.ensureBookPrice);
  const startImport = useAction(api.imports.start);

  const [title, setTitle] = useState("");
  const [issueNumber, setIssueNumber] = useState("");
  const [price, setPrice] = useState("9.99");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [source, setSourceFile] = useState<File | null>(null);
  const [cover, setCover] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string>("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openBook, setOpenBook] = useState<Id<"books"> | null>(null);

  if (me === undefined) return <div className="centered">Laden...</div>;
  if (!me?.isAdmin)
    return (
      <div className="centered">
        <h2>Kein Zugriff</h2>
        <p>Dieser Bereich ist der Redaktion vorbehalten.</p>
      </div>
    );

  async function upload(f: File): Promise<Id<"_storage">> {
    const url = await genUploadUrl();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": f.type || "application/octet-stream" },
      body: f,
    });
    if (!res.ok) throw new Error("Upload fehlgeschlagen");
    const { storageId } = await res.json();
    return storageId as Id<"_storage">;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    if (!file) {
      setErr("Druckdatei fehlt");
      return;
    }
    setBusy(true);
    try {
      setStep("Lade Druckdatei hoch...");
      const pdfStorageId = await upload(file);

      let coverStorageId: Id<"_storage"> | undefined;
      if (cover) {
        setStep("Lade Titelbild hoch...");
        coverStorageId = await upload(cover);
      }

      setStep("Analysiere Seiten...");
      const signedUrl = await getSignedStorageUrl({ storageId: pdfStorageId });
      if (!signedUrl) throw new Error("Storage-URL konnte nicht erzeugt werden");
      const ext = (file.name.split(".").pop() || "").toLowerCase();
      const filetype = ext === "epub" ? "epub" : "pdf";
      const inspectRes = await fetch(`${TILE_SERVICE_URL}/api/inspect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: signedUrl, filetype }),
      });
      if (!inspectRes.ok) {
        throw new Error(`Analyse fehlgeschlagen: ${await inspectRes.text()}`);
      }
      const { pageCount, width, height } = await inspectRes.json();

      setStep("Lege Ausgabe an...");
      const bookId = await createBook({
        title,
        filename: file.name,
        description: description || undefined,
        pdfStorageId,
        coverStorageId,
        pageCount,
        pageWidth: width,
        pageHeight: height,
        priceCents: Math.round(parseFloat(price) * 100),
        currency: "eur",
      });

      if (issueNumber.trim()) {
        await updateBook({ bookId, issueNumber: issueNumber.trim() });
      }

      if (source) {
        setStep("Lade IDML-Satzdatei hoch...");
        const sourceStorageId = await upload(source);
        await setSource({ bookId, sourceStorageId });
      }

      setMsg(`Ausgabe angelegt (${pageCount} Seiten, ${width}×${height}px)`);
      setTitle("");
      setIssueNumber("");
      setDescription("");
      setPrice("9.99");
      setFile(null);
      setSourceFile(null);
      setCover(null);
      (document.querySelectorAll<HTMLInputElement>('input[type="file"]') ?? []).forEach(
        (el) => (el.value = ""),
      );
    } catch (e: any) {
      setErr(e.message || "Fehler");
    } finally {
      setBusy(false);
      setStep("");
    }
  }

  async function guarded(fn: () => Promise<unknown>) {
    setErr(null);
    setMsg(null);
    try {
      await fn();
    } catch (e: any) {
      setErr(e?.message?.replace(/^\[.*?\]\s*/, "") ?? "Fehler");
    }
  }

  return (
    <div className="page admin">
      <h2>Redaktion</h2>
      <p className="hint">
        Angemeldet als <strong>{me.email}</strong>.
      </p>

      <section>
        <h3>Neue Ausgabe</h3>
        <form onSubmit={submit} className="admin-form">
          <label>
            Titel
            <input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>
          <label>
            Ausgabe (z.B. 3/2026)
            <input
              value={issueNumber}
              onChange={(e) => setIssueNumber(e.target.value)}
            />
          </label>
          <label>
            Beschreibung
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label>
            Preis (EUR)
            <input
              type="number"
              step="0.01"
              min="0"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              required
            />
          </label>
          <label>
            Druckdatei (PDF oder EPUB)
            <input
              type="file"
              accept=".pdf,.epub,application/pdf,application/epub+zip"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              required
            />
          </label>
          <label>
            Satzdatei IDML (optional, beste Artikelerkennung)
            <input
              type="file"
              accept=".idml"
              onChange={(e) => setSourceFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <label>
            Titelbild (optional)
            <input
              type="file"
              accept="image/*"
              onChange={(e) => setCover(e.target.files?.[0] ?? null)}
            />
          </label>
          <button className="btn" disabled={busy}>
            {busy ? step || "..." : "Anlegen"}
          </button>
          {msg && <div className="ok">{msg}</div>}
          {err && <div className="err">{err}</div>}
        </form>
        <p className="hint">
          IDML entsteht in InDesign über Datei → Exportieren → InDesign Markup
          (IDML). Eine binäre .indd-Datei lässt sich nicht auslesen.
        </p>
      </section>

      <AdminPlans />

      <section>
        <h3>Ausgaben</h3>
        <ul className="admin-books">
          {books?.map((b) => (
            <li key={b._id}>
              <div className="row">
                <span className="grow">
                  <strong>{b.title}</strong>
                  {b.issueNumber ? ` · ${b.issueNumber}` : ""} · {b.pageCount}{" "}
                  Seiten · {(b.priceCents / 100).toFixed(2)}{" "}
                  {b.currency.toUpperCase()}
                  <span className="hint">
                    {" "}
                    · {b.isPublished ? "veröffentlicht" : "unveröffentlicht"} ·{" "}
                    {b.publishedArticles}/{b.articleCount} Artikel frei
                    {b.stripePriceId ? " · Preis in Stripe" : " · kein Stripe-Preis"}
                    {b.lastImport
                      ? ` · Import ${b.lastImport.status}${
                          b.lastImport.message ? `: ${b.lastImport.message}` : ""
                        }`
                      : ""}
                  </span>
                </span>
              </div>
              <div className="row actions">
                <button
                  className="link-btn"
                  onClick={() =>
                    guarded(() =>
                      updateBook({ bookId: b._id, isPublished: !b.isPublished }),
                    )
                  }
                >
                  {b.isPublished ? "zurückziehen" : "veröffentlichen"}
                </button>
                <button
                  className="link-btn"
                  onClick={() =>
                    guarded(() =>
                      updateBook({
                        bookId: b._id,
                        includedInSubscription: !b.includedInSubscription,
                      }),
                    )
                  }
                >
                  {b.includedInSubscription ? "aus Abo nehmen" : "ins Abo geben"}
                </button>
                <button
                  className="link-btn"
                  onClick={() =>
                    guarded(async () => {
                      await ensurePrice({ bookId: b._id });
                      setMsg("Stripe-Preis angelegt.");
                    })
                  }
                >
                  Stripe-Preis anlegen
                </button>
                <button
                  className="link-btn"
                  onClick={() =>
                    guarded(async () => {
                      await startImport({ bookId: b._id, kind: "idml" });
                      setMsg("IDML-Import gestartet.");
                    })
                  }
                >
                  Artikel aus IDML
                </button>
                <button
                  className="link-btn"
                  onClick={() =>
                    guarded(async () => {
                      await startImport({ bookId: b._id, kind: "pdf" });
                      setMsg("PDF-Import gestartet.");
                    })
                  }
                >
                  Artikel aus PDF
                </button>
                <button
                  className="link-btn"
                  onClick={() =>
                    setOpenBook(openBook === b._id ? null : b._id)
                  }
                >
                  {openBook === b._id ? "Artikel schliessen" : "Artikel"}
                </button>
                <button
                  className="link-btn"
                  onClick={() => guarded(() => adminGrantSelf({ bookId: b._id }))}
                >
                  mir freischalten
                </button>
                <button
                  className="link-btn danger"
                  onClick={() => {
                    if (
                      !confirm(
                        `"${b.title}" löschen? Auch Artikel und Freischaltungen.`,
                      )
                    )
                      return;
                    guarded(() => deleteBook({ bookId: b._id }));
                  }}
                >
                  löschen
                </button>
              </div>
              {openBook === b._id && <AdminArticles bookId={b._id} />}
            </li>
          ))}
          {books?.length === 0 && <li className="hint">Noch keine Ausgabe.</li>}
        </ul>
      </section>
    </div>
  );
}
