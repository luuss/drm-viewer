import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api, TILE_SERVICE_URL, type Id } from "../lib/convex";

export default function AdminPage() {
  const me = useQuery(api.users.me, {});
  const books = useQuery(api.books.list, {});
  const genUploadUrl = useMutation(api.books.generateUploadUrl);
  const getSignedStorageUrl = useMutation(api.books.getSignedStorageUrl);
  const createBook = useMutation(api.books.createBook);
  const deleteBook = useMutation(api.books.deleteBook);
  const adminGrantSelf = useMutation(api.books.adminGrantSelf);

  const [title, setTitle] = useState("");
  const [price, setPrice] = useState("9.99");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [cover, setCover] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string>("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (me === undefined) return <div className="centered">Laden...</div>;
  if (!me?.isAdmin)
    return (
      <div className="centered">
        <h2>Kein Zugriff</h2>
        <p>Dieser Bereich ist Admins vorbehalten.</p>
      </div>
    );

  async function upload(file: File): Promise<Id<"_storage">> {
    const url = await genUploadUrl();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
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
      setErr("Datei fehlt");
      return;
    }
    setBusy(true);
    try {
      setStep("Lade PDF/EPUB hoch...");
      const pdfStorageId = await upload(file);

      let coverStorageId: Id<"_storage"> | undefined;
      if (cover) {
        setStep("Lade Cover hoch...");
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
        const txt = await inspectRes.text();
        throw new Error(`Analyse fehlgeschlagen: ${txt}`);
      }
      const { pageCount, width, height } = await inspectRes.json();

      setStep("Speichere Buch...");
      await createBook({
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

      setMsg(`Buch angelegt (${pageCount} Seiten, ${width}×${height}px)`);
      setTitle("");
      setDescription("");
      setPrice("9.99");
      setFile(null);
      setCover(null);
      (document.getElementById("book-file") as HTMLInputElement | null)?.value &&
        ((document.getElementById("book-file") as HTMLInputElement).value = "");
      (document.getElementById("book-cover") as HTMLInputElement | null)?.value &&
        ((document.getElementById("book-cover") as HTMLInputElement).value = "");
    } catch (e: any) {
      setErr(e.message || "Fehler");
    } finally {
      setBusy(false);
      setStep("");
    }
  }

  return (
    <div className="page">
      <h2>Admin</h2>
      <p className="hint">
        Eingeloggt als <strong>{me.email}</strong>.
      </p>

      <h3>Neues Buch</h3>
      <form onSubmit={submit} className="admin-form">
        <label>
          Titel
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
        </label>
        <label>
          Beschreibung (optional)
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
          Datei (PDF oder EPUB)
          <input
            id="book-file"
            type="file"
            accept=".pdf,.epub,application/pdf,application/epub+zip"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            required
          />
        </label>
        <label>
          Cover (optional)
          <input
            id="book-cover"
            type="file"
            accept="image/*"
            onChange={(e) => setCover(e.target.files?.[0] ?? null)}
          />
        </label>
        <button className="btn" disabled={busy}>
          {busy ? (step || "...") : "Anlegen"}
        </button>
        {msg && <div className="ok">{msg}</div>}
        {err && <div className="err">{err}</div>}
      </form>

      <h3>Bücher</h3>
      <ul className="admin-books">
        {books?.map((b) => (
          <li key={b._id}>
            <span>
              <strong>{b.title}</strong> — {b.pageCount} Seiten — {(b.priceCents / 100).toFixed(2)} {b.currency}
            </span>
            <span style={{ display: "flex", gap: "1rem" }}>
              <button
                className="link-btn"
                onClick={async () => {
                  try {
                    await adminGrantSelf({ bookId: b._id });
                  } catch (e: any) { alert(e.message); }
                }}
              >
                Freischalten
              </button>
              <button
                className="link-btn"
                onClick={async () => {
                  if (!confirm(`"${b.title}" wirklich löschen? Auch alle Entitlements.`)) return;
                  try {
                    await deleteBook({ bookId: b._id });
                  } catch (e: any) {
                    alert(e.message);
                  }
                }}
              >
                Löschen
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
