#!/usr/bin/env node
/**
 * Die Umgebungswerte des selbst betriebenen Convex-Backends setzen.
 *
 * Aufruf (nach `convex deploy`):
 *   CONVEX_SELF_HOSTED_URL=... CONVEX_SELF_HOSTED_ADMIN_KEY=... \
 *   node scripts/convex-env-sichern.mjs
 *
 * Das Skript ist absichtlich stumpf und wiederholbar: es liest die gesetzten
 * Werte, schreibt nur, was fehlt oder abweicht, und erzeugt die Schluessel der
 * Anmeldung genau einmal. Ein zweiter Lauf aendert nichts — sonst waere nach
 * jedem Deployment jede Sitzung ungueltig.
 */
import { execFileSync } from "node:child_process";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";

const pflicht = [
  "APP_PUBLIC_URL",
  "PUBLIC_TILE_ORIGIN",
  "TILE_SERVICE_SECRET",
  "EXTRACT_SERVICE_SECRET",
  "S3_ENDPOINT_URL",
  "MEDIA_BUCKET",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_REGION",
];
const freiwillig = [
  "ADMIN_EMAILS",
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
  "STRIPE_SECRET_KEY",
  "SHOP_WEBHOOK_SECRET",
  "REQUIRE_EMAIL_VERIFICATION",
  "MAX_UPLOAD_BYTES",
  "MAX_ACTIVE_SESSIONS",
];

function convex(args) {
  return execFileSync("npx", ["convex", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function gesetzteWerte() {
  // `env list` gibt "NAME=wert" je Zeile aus.
  const roh = convex(["env", "list"]);
  const map = new Map();
  for (const zeile of roh.split("\n")) {
    const stelle = zeile.indexOf("=");
    if (stelle > 0) map.set(zeile.slice(0, stelle).trim(), zeile.slice(stelle + 1));
  }
  return map;
}

function setzen(name, wert) {
  // Mehrzeilige Werte kann die CLI nicht, und ein fuehrendes "-----BEGIN"
  // haelt sie fuer eine Option. Beides umgeht `--` plus Zeilen als Leerzeichen,
  // genau wie es @convex-dev/auth selbst macht.
  convex(["env", "set", "--", `${name}=${wert.replace(/\n/g, " ")}`]);
  console.log(`  gesetzt: ${name}`);
}

async function anmeldeschluessel(vorhanden) {
  if (vorhanden.has("JWT_PRIVATE_KEY") && vorhanden.has("JWKS")) {
    console.log("  Anmeldeschluessel stehen bereits.");
    return;
  }
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  setzen("JWT_PRIVATE_KEY", await exportPKCS8(privateKey));
  const jwk = await exportJWK(publicKey);
  setzen("JWKS", JSON.stringify({ keys: [{ use: "sig", ...jwk }] }));
}

async function main() {
  if (!process.env.CONVEX_SELF_HOSTED_URL || !process.env.CONVEX_SELF_HOSTED_ADMIN_KEY) {
    console.error(
      "CONVEX_SELF_HOSTED_URL und CONVEX_SELF_HOSTED_ADMIN_KEY muessen gesetzt sein.",
    );
    process.exit(2);
  }

  const fehlend = pflicht.filter((name) => !process.env[name]);
  if (fehlend.length) {
    console.error(`Diese Werte fehlen in der Umgebung: ${fehlend.join(", ")}`);
    process.exit(2);
  }

  const vorhanden = gesetzteWerte();
  console.log(`Backend kennt ${vorhanden.size} Werte.`);

  for (const name of [...pflicht, ...freiwillig]) {
    const wert = process.env[name];
    if (!wert) continue;
    if (vorhanden.get(name) === wert) continue;
    setzen(name, wert);
  }

  // SITE_URL braucht @convex-dev/auth fuer die Rueckadressen der Anmeldung.
  if (vorhanden.get("SITE_URL") !== process.env.APP_PUBLIC_URL) {
    setzen("SITE_URL", process.env.APP_PUBLIC_URL);
  }

  await anmeldeschluessel(vorhanden);
  console.log("Umgebungswerte stehen.");
}

await main();
