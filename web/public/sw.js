/*
 * Service Worker: die Huelle der Anwendung (HTML, Skripte, Stile, Schriften,
 * Logos), damit der Reader auch ohne Verbindung startet. Inhalte der Hefte
 * liegen hier nie: die haelt der Reader verschluesselt in seinem Offline-
 * Puffer (src/reader/puffer.ts). Anfragen an Convex, das Kachel-Gateway, die
 * Medien und die Hooks gehen unberuehrt durchs Netz.
 *
 * Notbremse: eine sw.js, die nur `self.registration.unregister()` ruft,
 * schaltet ihn bei allen Lesern ab (HANDOVER, Abschnitt Offline-Puffer).
 */
const HUELLE = "huelle-1";
const START = "/";
/** Unveraenderliche Dateien (Name mit Hash) und Beiwerk der Oberflaeche. */
const STATISCH = /^\/(assets|fonts|img)\/|^\/favicon\.ico$/;
/** Nie anfassen, auch nicht als Seitenaufruf. */
const DURCH = /^\/(api|convex|hooks|medien|\.well-known)(\/|$)/;
/** So lange darf die Seite aus dem Netz brauchen, dann kommt die gemerkte. */
const SEITE_WARTEN_MS = 4000;

function dateienIn(html) {
  return [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
}

/** Neue Huelle merken; die Dateien eines alten Stands fallen weg. */
async function huelleMerken(cache, res) {
  const html = await res.clone().text();
  if (!html.includes('id="root"')) return;
  const alt = await cache.match(START);
  const altHtml = alt ? await alt.text() : "";
  await cache.put(START, res);
  if (altHtml === html) return;
  const dateien = dateienIn(html);
  await Promise.all(
    dateien.map((d) =>
      cache
        .match(d)
        .then((da) => da || cache.add(d))
        .catch(() => undefined),
    ),
  );
  const behalten = new Set(dateien.map((d) => new URL(d, self.location.origin).pathname));
  for (const req of await cache.keys()) {
    const pfad = new URL(req.url).pathname;
    if (pfad.startsWith("/assets/") && !behalten.has(pfad)) await cache.delete(req);
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(HUELLE);
      const res = await fetch(START, { cache: "no-store" });
      if (res.ok) await huelleMerken(cache, res);
    })().catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name !== HUELLE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

/** Seitenaufruf: aus dem Netz, ohne Netz (oder zu langsam) die gemerkte Huelle. */
async function seite(cache, netz) {
  const gemerkt = await cache.match(START);
  if (!gemerkt) return netz;
  const spaet = new Promise((ok) => setTimeout(() => ok(null), SEITE_WARTEN_MS));
  try {
    return (await Promise.race([netz, spaet])) || gemerkt;
  } catch {
    return gemerkt;
  }
}

/** Dateien mit Hash aus dem Cache; Schriften und Bilder auffrischen, wenn Netz da ist. */
async function datei(request) {
  const cache = await caches.open(HUELLE);
  const da = await cache.match(request);
  if (da && new URL(request.url).pathname.startsWith("/assets/")) return da;
  const netz = fetch(request).then((res) => {
    if (res.ok && res.type === "basic") void cache.put(request, res.clone());
    return res;
  });
  if (da) {
    netz.catch(() => undefined);
    return da;
  }
  return netz;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || DURCH.test(url.pathname)) return;
  if (req.mode === "navigate") {
    // Der Abruf beginnt sofort; das Merken der neuen Huelle haelt den Worker
    // wach, auch wenn die Antwort schon aus dem Cache kam.
    // Die Kopie entsteht in der ersten Reaktion auf die Antwort, bevor der
    // Browser ihren Inhalt liest.
    const netz = fetch(req);
    const kopie = netz.then((res) => res.clone());
    const cache = caches.open(HUELLE);
    event.waitUntil(
      Promise.all([kopie, cache])
        .then(([res, c]) => {
          const typ = res.headers.get("content-type") || "";
          if (res.ok && res.type === "basic" && typ.includes("text/html")) {
            return huelleMerken(c, res);
          }
        })
        .catch(() => undefined),
    );
    event.respondWith(cache.then((c) => seite(c, netz)));
    return;
  }
  if (STATISCH.test(url.pathname)) event.respondWith(datei(req));
});

/** Die Seite meldet, was sie schon geladen hatte, bevor dieser Worker lief. */
self.addEventListener("message", (event) => {
  if (!event.data || event.data.typ !== "huelle" || !Array.isArray(event.data.dateien)) return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(HUELLE);
      for (const pfad of event.data.dateien) {
        if (typeof pfad !== "string" || !STATISCH.test(pfad)) continue;
        if (!(await cache.match(pfad))) await cache.add(pfad).catch(() => undefined);
      }
    })(),
  );
});
