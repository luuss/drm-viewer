import { describe, expect, it } from "vitest";
import { presignPut } from "./s3Presign";

// Erzeugt mit @aws-sdk/s3-request-presigner (getSignedUrl, PutObjectCommand,
// forcePathStyle, signingDate 2026-09-30T12:00:00Z). Die eigene Signatur muss
// bitgleich sein, sonst lehnt der Medienspeicher mit 403 ab.
const SDK =
  "https://medien.example.de/emag-media/uploads/abc/1-seite%20001.jpg" +
  "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD" +
  "&X-Amz-Credential=AKID%2F20260930%2Fus-east-1%2Fs3%2Faws4_request" +
  "&X-Amz-Date=20260930T120000Z&X-Amz-Expires=900" +
  "&X-Amz-Signature=10daf2e4be78aa590c0f8748f8fe971576478ed1cd0d5ed9a490d1f927e34cad" +
  "&X-Amz-SignedHeaders=host&x-id=PutObject";

function parts(u: string) {
  const url = new URL(u);
  return {
    base: `${url.origin}${url.pathname}`,
    query: Object.fromEntries(url.searchParams),
  };
}

describe("presignPut", () => {
  it("signiert wie das AWS-SDK", async () => {
    const url = await presignPut({
      endpoint: "https://medien.example.de",
      region: "us-east-1",
      accessKeyId: "AKID",
      secretAccessKey: "SECRET",
      bucket: "emag-media",
      key: "uploads/abc/1-seite 001.jpg",
      expiresIn: 900,
      now: new Date("2026-09-30T12:00:00Z"),
    });
    expect(parts(url)).toEqual(parts(SDK));
  });

  it("setzt den Proxy-Vorsatz nur in die Adresse, nicht in die Signatur", async () => {
    const url = await presignPut({
      endpoint: "https://medien.example.de/medien/",
      region: "us-east-1",
      accessKeyId: "AKID",
      secretAccessKey: "SECRET",
      bucket: "emag-media",
      key: "uploads/abc/1-seite 001.jpg",
      expiresIn: 900,
      now: new Date("2026-09-30T12:00:00Z"),
    });
    // MinIO sieht /emag-media/… — die Signatur ist dieselbe wie ohne Vorsatz.
    const ohne = parts(SDK);
    expect(parts(url)).toEqual({
      base: ohne.base.replace("example.de/", "example.de/medien/"),
      query: ohne.query,
    });
  });

  it("behaelt einen abweichenden Port im Host", async () => {
    const url = await presignPut({
      endpoint: "http://minio:9000/",
      region: "us-east-1",
      accessKeyId: "AKID",
      secretAccessKey: "SECRET",
      bucket: "emag-media",
      key: "a/b.jpg",
      expiresIn: 60,
    });
    expect(url.startsWith("http://minio:9000/emag-media/a/b.jpg?")).toBe(true);
  });
});
