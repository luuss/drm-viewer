// Titel und Reihe aller Hefte mit den Regeln des Imports pruefen.
//
//   node tools/weltkrieg/titel_pruefen.mjs <ordner> [archivliste.json]
//
// <ordner> legt tools/weltkrieg/titel_pruefen.sh an: issues.jsonl,
// pubs.jsonl, cov/<issueId>.json (Textebene des Umschlags), inner/<issueId>.json
// (Textebene des Innenteils) und bund/ (heftTitel.ts, umschlagTitel.ts,
// reihen.ts mit esbuild gebuendelt). Mit der Ordnerliste des Archivs
// (Admin -> "Ordnerstruktur") werden auch die Reihenordner verglichen.
//
// Schreibt <ordner>/ergebnis.json:
//   titel:   sichere Berichtigungen (beide Quellen einig oder Heftnummer),
//            fuer devtools:titelBerichtigenInternal
//   pruefen: Vermerke "Titel pruefen" (setzen oder aufheben), fuer
//            devtools:titelPruefenInternal. Bei einem Vermerk bleibt der Titel.
//   reihe:   Hefte, deren Titelseite eine andere Reihe nennt (nur Bericht)
//   archiv:  Hefte des Archivs ohne Gegenstueck in der Anlage (nur Bericht)
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
const archivListe = process.argv[3];
if (!dir) {
  console.error("Aufruf: node tools/weltkrieg/titel_pruefen.mjs <ordner> [archivliste.json]");
  process.exit(2);
}
const bund = (f) => import(path.resolve(dir, "bund", f));
const { kolumnentitel, titelEntscheiden } = await bund("heftTitel.js");
const { nameVomUmschlag, schreibungAusSatz, schreibungJeWort, woerterImSatz, ausVersalien } = await bund("umschlagTitel.js");
const { REIHEN } = await bund("reihen.js");
const { reiheAusArchivpfad, hefteImArchiv } = await bund("heftarchiv.js");

const zeilen = (f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
const issues = zeilen("issues.jsonl");
const pubs = new Map(zeilen("pubs.jsonl").map((p) => [p._id, p.name]));
const lesen = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null);
const seitenText = (p) => [...p.items].sort((a, b) => a[2] - b[2] || a[1] - b[1]).map((i) => i[0]).join("\n");

const ergebnis = { titel: [], pruefen: [], reihe: [], archiv: [], ohneTextebene: [] };
const zaehler = {};
for (const issue of issues) {
  const reihe = pubs.get(issue.publicationId) ?? "?";
  const cov = lesen(path.join(dir, "cov", `${issue._id}.json`));
  const inn = lesen(path.join(dir, "inner", `${issue._id}.json`));
  if (!cov || !inn) {
    ergebnis.ohneTextebene.push(`${reihe} ${issue.issueNumber ?? ""} ${issue.title}`);
    continue;
  }
  const u1 = cov.pages.find((p) => p.role === "front_cover") ?? cov.pages[0];
  const vomUmschlag = u1 ? nameVomUmschlag(u1.items, REIHEN) : null;
  if (vomUmschlag?.reihe && vomUmschlag.reihe !== reihe) {
    ergebnis.reihe.push({ issueId: issue._id, nummer: issue.issueNumber, titel: issue.title, reihe, titelseite: vomUmschlag.reihe });
  }
  const texte = inn.pages.map(seitenText);
  const gedruckt = vomUmschlag?.titelGedruckt || null;
  const ausSatz = gedruckt ? schreibungAusSatz(gedruckt, texte) : null;
  const umschlag = gedruckt ? (ausSatz ?? schreibungJeWort(gedruckt, texte) ?? ausVersalien(gedruckt)) : null;
  const e = titelEntscheiden({
    umschlag,
    umschlagBestaetigt: !!ausSatz || (!!umschlag && woerterImSatz(umschlag, texte)),
    kolumne: kolumnentitel(inn.pages),
    reihe,
    nummer: issue.issueNumber,
  });
  zaehler[e.quelle + (e.pruefen ? " + pruefen" : "")] = (zaehler[e.quelle + (e.pruefen ? " + pruefen" : "")] ?? 0) + 1;
  const kennung = `${reihe.replace(/^Weltkrieg /, "")} ${issue.issueNumber ?? ""}`;
  if (e.pruefen) {
    ergebnis.pruefen.push({ issueId: issue._id, pruefen: e.pruefen, kennung, titel: issue.title });
  } else {
    if (issue.titelPruefen) ergebnis.pruefen.push({ issueId: issue._id, pruefen: null, kennung, titel: issue.title });
    if (e.titel !== issue.title) ergebnis.titel.push({ issueId: issue._id, alt: issue.title, titel: e.titel, kennung, quelle: e.quelle });
  }
}

if (archivListe) {
  const liste = JSON.parse(fs.readFileSync(archivListe, "utf8"));
  const dateien = liste.dateien.map(([p, size]) => ({ path: p, name: p.split("/").pop(), size, file: null }));
  const inAnlage = new Set(issues.map((i) => `${pubs.get(i.publicationId)}|${String(i.issueNumber ?? "").replace(/^0+/, "")}`));
  for (const heft of hefteImArchiv(dateien)) {
    const r = reiheAusArchivpfad(heft.pfad);
    const nr = (heft.kennung.match(/^\d+/) ?? [""])[0].replace(/^0+/, "");
    if (r && nr && !inAnlage.has(`${r}|${nr}`)) ergebnis.archiv.push({ reihe: r, nummer: nr, pfad: heft.pfad });
  }
}

fs.writeFileSync(path.join(dir, "ergebnis.json"), JSON.stringify(ergebnis, null, 1));
console.log(`${issues.length} Hefte`, zaehler);
console.log(`\nSichere Berichtigungen: ${ergebnis.titel.length}`);
for (const t of ergebnis.titel) console.log(`  ${t.kennung}: „${t.alt}“ -> „${t.titel}“ (${t.quelle})`);
const setzen = ergebnis.pruefen.filter((p) => p.pruefen);
console.log(`\nTitel pruefen: ${setzen.length}, Vermerk aufheben: ${ergebnis.pruefen.length - setzen.length}`);
for (const p of setzen) {
  console.log(`  ${p.kennung} „${p.titel}“: ${p.pruefen.grund}` +
    (p.pruefen.umschlag ? ` | Titelseite „${p.pruefen.umschlag}“` : "") +
    (p.pruefen.kolumne ? ` | Kolumne „${p.pruefen.kolumne}“` : ""));
}
console.log(`\nAndere Reihe auf der Titelseite: ${ergebnis.reihe.length}`);
for (const r of ergebnis.reihe) console.log(`  ${r.reihe} ${r.nummer} „${r.titel}“ -> Titelseite: ${r.titelseite}`);
if (archivListe) {
  console.log(`\nIm Archiv, fehlt in der Anlage: ${ergebnis.archiv.length}`);
  for (const a of ergebnis.archiv) console.log(`  ${a.reihe} ${a.nummer}: ${a.pfad}`);
}
if (ergebnis.ohneTextebene.length) console.log(`\nOhne Textebene (nicht geprueft): ${ergebnis.ohneTextebene.length}`);
