/**
 * Vorsignierte PUT-Adresse fuer den Medienspeicher (AWS Signature V4).
 *
 * Von Hand statt mit dem AWS-SDK, damit `uploads.presignUpload` ohne
 * `"use node"` auskommt. Node-Aktionen rufen fuer `ctx.runQuery` das Backend
 * ueber die oeffentliche Adresse zurueck; auf dem Verlagsserver ging das an
 * das Kachel-Gateway, und jeder Import brach beim ersten Upload ab. Eine
 * Aktion in der Standardlaufzeit fragt das Backend direkt.
 *
 * Signiert wird nur `host`, wie beim SDK. Die Adresse ist bitgleich zu
 * `getSignedUrl` (siehe s3Presign.test.ts).
 *
 * Ein Pfad im Endpunkt ist ein Vorsatz des Proxys, kein Teil des Speichers:
 * `https://lesen.lesenundschenken.de/medien` heisst, Apache nimmt `/medien`
 * ab und reicht den Rest samt Host an MinIO. Signiert wird deshalb der Pfad,
 * den MinIO sieht; der Vorsatz steht nur in der Adresse fuer den Browser.
 * So braucht der Medienspeicher keinen eigenen Namen — `medien.lesen.…` lag
 * zwei Ebenen tief, und dafuer hat Cloudflare kein Zertifikat.
 */

export type PresignInput = {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  key: string;
  expiresIn: number;
  /** Fuer Tests; sonst jetzt. */
  now?: Date;
};

const encoder = new TextEncoder();

/** RFC 3986, wie S3 es erwartet: auch !'()* werden kodiert. */
function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(s)));
}

async function hmac(key: ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return await crypto.subtle.sign("HMAC", k, encoder.encode(data));
}

/** 20260930T141500Z */
function amzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export async function presignPut(input: PresignInput): Promise<string> {
  const url = new URL(input.endpoint);
  // Pfadstil: /<bucket>/<key>. Jeder Abschnitt einzeln kodiert, die
  // Schraegstriche bleiben.
  const vorsatz = url.pathname.replace(/\/+$/, "");
  const pfad = "/" + [input.bucket, ...input.key.split("/")].map(uriEncode).join("/");

  const zeit = amzDate(input.now ?? new Date());
  const tag = zeit.slice(0, 8);
  const scope = `${tag}/${input.region}/s3/aws4_request`;
  const signedHeaders = "host";

  const query: [string, string][] = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Content-Sha256", "UNSIGNED-PAYLOAD"],
    ["X-Amz-Credential", `${input.accessKeyId}/${scope}`],
    ["X-Amz-Date", zeit],
    ["X-Amz-Expires", String(input.expiresIn)],
    ["X-Amz-SignedHeaders", signedHeaders],
    ["x-id", "PutObject"],
  ];
  const canonicalQuery = query
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  // `url.host` enthaelt den Port nur, wenn er vom Standard abweicht — genau
  // so schickt ihn auch der Browser.
  const canonicalHeaders = `host:${url.host}\n`;

  const canonicalRequest = [
    "PUT",
    pfad,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    zeit,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  let schluessel = await hmac(
    encoder.encode(`AWS4${input.secretAccessKey}`).buffer as ArrayBuffer,
    tag,
  );
  schluessel = await hmac(schluessel, input.region);
  schluessel = await hmac(schluessel, "s3");
  schluessel = await hmac(schluessel, "aws4_request");
  const signatur = hex(await hmac(schluessel, stringToSign));

  return (
    `${url.protocol}//${url.host}${vorsatz}${pfad}` +
    `?${canonicalQuery}&X-Amz-Signature=${signatur}`
  );
}
