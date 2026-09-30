import { v } from "convex/values";
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import { assertUploadAllowed } from "./uploadRules";
import { presignPut } from "./s3Presign";

/**
 * Zweiter Uploadweg: der Browser laedt grosse Dateien direkt in den
 * Medienspeicher, nicht ueber den Server. Er bekommt dafuer eine kurzlebige
 * signierte Adresse.
 *
 * Die Pruefungen sind dieselben wie beim vermittelten Weg: Rolle, Dateityp und
 * Groesse werden hier geprueft, die Ablage wird danach ueber
 * `assets.registerUpload` eingetragen. Ohne eingerichtetes S3 gibt es keine
 * Adresse — dann laeuft der vermittelte Weg.
 *
 * Bewusst ohne `"use node"`: eine Node-Aktion ruft fuer `ctx.runQuery` das
 * Backend ueber die oeffentliche Adresse zurueck, und das hing am Apache-
 * Routing des Verlagsservers (drm-viewer-s5j). Signiert wird in `s3Presign`.
 */
export const presignUpload = action({
  args: {
    issueId: v.id("issues"),
    filename: v.string(),
    contentType: v.string(),
    bytes: v.number(),
  },
  handler: async (ctx, args): Promise<{ url: string; key: string } | null> => {
    await ctx.runQuery(api.users.requireRoleQuery, { role: "editor" });
    assertUploadAllowed(args.contentType, args.bytes, args.filename);

    const endpoint = process.env.S3_ENDPOINT_URL;
    const bucket = process.env.MEDIA_BUCKET ?? "emag-media";
    if (!endpoint) return null;

    const safeName = args.filename.replace(/[^\w.\-]+/g, "_").slice(-120);
    const key = `uploads/${args.issueId}/${Date.now()}-${safeName}`;
    const url = await presignPut({
      endpoint,
      region: process.env.AWS_REGION ?? "us-east-1",
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
      bucket,
      key,
      expiresIn: 900,
    });
    return { url, key };
  },
});
