"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

export const sendClaimEmail = internalAction({
  args: {
    email: v.string(),
    bookId: v.id("books"),
    token: v.string(),
  },
  handler: async (ctx, { email, bookId, token }) => {
    const book = await ctx.runQuery(api.books.getBook, { bookId });
    const title = book?.title ?? "dein Buch";
    const appUrl = process.env.APP_PUBLIC_URL ?? "http://localhost:5173";
    const claimUrl = `${appUrl}/claim/${token}`;

    const apiKey = process.env.RESEND_API_KEY;
    const from =
      process.env.RESEND_FROM_EMAIL ?? "DRM Reader <noreply@example.com>";

    if (!apiKey) {
      console.log(
        `[email:stub] would send to ${email}: ${title} — ${claimUrl}`,
      );
      return { ok: true, stubbed: true };
    }

    const html = `
      <div style="font-family:sans-serif;max-width:520px;margin:auto;padding:24px">
        <h2 style="color:#e94560">Dein Buch ist bereit</h2>
        <p>Hallo,</p>
        <p>vielen Dank für deinen Kauf von <strong>${escapeHtml(title)}</strong>.</p>
        <p>
          <a href="${claimUrl}" style="display:inline-block;background:#e94560;color:#fff;
             padding:12px 20px;border-radius:6px;text-decoration:none">Buch freischalten</a>
        </p>
        <p style="color:#666;font-size:13px">
          Der Link ist <strong>30 Tage</strong> gültig und kann nur einmal eingelöst werden.
          Wenn du noch keinen Account hast, kannst du dir beim Öffnen einen erstellen.
          Nach dem Einlösen ist das Buch dauerhaft an deinen Account gebunden.
        </p>
        <p style="color:#999;font-size:12px">
          Falls der Button nicht funktioniert: ${claimUrl}
        </p>
      </div>`;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: email,
        subject: `Dein Buch: ${title}`,
        html,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Resend failed: ${res.status} ${text}`);
    }
    return { ok: true, stubbed: false };
  },
});

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
