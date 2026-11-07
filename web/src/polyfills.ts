/**
 * Kleine Polyfills fuer aeltere Safaris (iPhone). Muss als erstes Modul in
 * main.tsx stehen. Jede Funktion wird nur gesetzt, wenn sie fehlt.
 *
 * Hintergrund 07.11.2026: Auf iOS 18.1 blieb die Seite weiss, weil pdf.js 6
 * beim Laden `Iterator` braucht. pdf.js laedt jetzt erst im Admin
 * (pageRender.ts), braucht dort aber weiter Funktionen, die Safari erst
 * spaeter kennt: Promise.withResolvers (17.4), URL.parse (18), Promise.try
 * und Map#getOrInsertComputed (noch neuer).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

const P = Promise as any;
if (typeof P.withResolvers !== "function") {
  P.withResolvers = function () {
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise((a, b) => {
      resolve = a;
      reject = b;
    });
    return { promise, resolve, reject };
  };
}
if (typeof P.try !== "function") {
  P.try = function (f: (...a: unknown[]) => unknown, ...args: unknown[]) {
    return new Promise((resolve) => resolve(f(...args)));
  };
}

const U = URL as any;
if (typeof U.parse !== "function") {
  U.parse = function (url: string | URL, base?: string | URL) {
    try {
      return new URL(url, base);
    } catch {
      return null;
    }
  };
}

for (const C of [Map, WeakMap] as any[]) {
  const proto = C.prototype;
  if (typeof proto.getOrInsert !== "function") {
    Object.defineProperty(proto, "getOrInsert", {
      configurable: true,
      writable: true,
      value(this: Map<unknown, unknown>, key: unknown, value: unknown) {
        if (!this.has(key)) this.set(key, value);
        return this.get(key);
      },
    });
  }
  if (typeof proto.getOrInsertComputed !== "function") {
    Object.defineProperty(proto, "getOrInsertComputed", {
      configurable: true,
      writable: true,
      value(this: Map<unknown, unknown>, key: unknown, f: (k: unknown) => unknown) {
        if (!this.has(key)) this.set(key, f(key));
        return this.get(key);
      },
    });
  }
}

export {};
