import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { api } from "./_generated/api";
import { sendMail, layout, escapeHtml, appUrl } from "./mail";

export const sendClaimEmail = internalAction({
  args: { email: v.string(), issueId: v.id("issues"), token: v.string() },
  handler: async (ctx, { email, issueId }): Promise<{ ok: boolean; stubbed: boolean }> => {
    const issue: any = await ctx.runQuery(api.issues.getPublic, { issueId });
    const title: string = issue?.title ?? "deine Ausgabe";
    // Kein Einloeselink mehr: die Ausgabe haengt an der Kaufadresse und ist
    // da, sobald man sich mit dieser Adresse anmeldet.
    const loginUrl = `${appUrl()}/login`;
    return await sendMail({
      to: email,
      subject: `Deine Ausgabe: ${title}`,
      html: layout(
        "Deine Ausgabe ist bereit",
        `<p>vielen Dank fuer deinen Kauf von <strong>${escapeHtml(title)}</strong>.</p>
         <p>Melde dich mit dieser E-Mail-Adresse (${escapeHtml(email)}) an, dann steht
            die Ausgabe in deiner Bibliothek.</p>
         <p><a href="${loginUrl}" style="display:inline-block;background:#e94560;color:#fff;
            padding:12px 20px;border-radius:6px;text-decoration:none">Anmelden</a></p>
         <p style="color:#999;font-size:12px">Falls der Button nicht geht: ${loginUrl}</p>`,
      ),
    });
  },
});

export const sendSubscriptionStarted = internalAction({
  args: { email: v.string() },
  handler: async (_ctx, { email }) => {
    return await sendMail({
      to: email,
      subject: "Dein Abo ist aktiv",
      html: layout(
        "Abo aktiv",
        `<p>Dein Abo laeuft. Alle freigegebenen Ausgaben stehen ab sofort in deiner
            Bibliothek bereit.</p>
         <p><a href="${appUrl()}/library">Zur Bibliothek</a></p>
         <p style="color:#666;font-size:13px">Kuendigung, Zahlungsmittel und Rechnungen
            verwaltest du jederzeit selbst unter Profil.</p>`,
      ),
    });
  },
});

export const sendPaymentFailed = internalAction({
  args: { email: v.string() },
  handler: async (_ctx, { email }) => {
    return await sendMail({
      to: email,
      subject: "Zahlung fehlgeschlagen",
      html: layout(
        "Zahlung fehlgeschlagen",
        `<p>Die letzte Abbuchung fuer dein Abo ist nicht durchgegangen.</p>
         <p>Bitte hinterlege ein gueltiges Zahlungsmittel, sonst endet der Zugriff
            in wenigen Tagen.</p>
         <p><a href="${appUrl()}/profile">Zahlungsmittel aktualisieren</a></p>`,
      ),
    });
  },
});

export const sendAccountDeleted = internalAction({
  args: { email: v.string() },
  handler: async (_ctx, { email }) => {
    return await sendMail({
      to: email,
      subject: "Account geloescht",
      html: layout(
        "Account geloescht",
        `<p>Dein Konto und alle zugehoerigen Lesedaten wurden geloescht.</p>
         <p style="color:#666;font-size:13px">Rechnungsbelege bleiben aus steuerrechtlichen
            Gruenden bei unserem Zahlungsdienstleister gespeichert.</p>`,
      ),
    });
  },
});
