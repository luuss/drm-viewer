"use node";

import { v } from "convex/values";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import { assertUploadAllowed } from "./uploadRules";

/**
 * Zweiter Uploadweg: der Browser laedt grosse Dateien direkt in den
 * Medienspeicher, nicht ueber den Server. Er bekommt dafuer eine kurzlebige
 * signierte Adresse.
 *
 * Die Pruefungen sind dieselben wie beim vermittelten Weg: Rolle, Dateityp und
 * Groesse werden hier geprueft, die Ablage wird danach ueber
 * `assets.registerUpload` eingetragen. Ohne eingerichtetes S3 gibt es keine
 * Adresse — dann laeuft der vermittelte Weg.
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

    const client = new S3Client({
      endpoint,
      region: process.env.AWS_REGION ?? "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
      },
    });
    const safeName = args.filename.replace(/[^\w.\-]+/g, "_").slice(-120);
    const key = `uploads/${args.issueId}/${Date.now()}-${safeName}`;
    const url = await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: args.contentType }),
      { expiresIn: 900 },
    );
    return { url, key };
  },
});
