import { Email } from "@convex-dev/auth/providers/Email";
import { sendMail, layout, escapeHtml } from "./mail";

/** 8-stelliger Zahlencode. Keine Zusatz-Abhaengigkeit noetig. */
function numericCode(length = 8): string {
  // Werte ab 250 verwerfen: 256 ist nicht durch 10 teilbar, sonst waeren die
  // Ziffern 0 bis 5 haeufiger.
  const out: string[] = [];
  while (out.length < length) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b >= 250) continue;
      out.push((b % 10).toString());
      if (out.length === length) break;
    }
  }
  return out.join("");
}

export const ResendOTPPasswordReset = Email({
  id: "resend-otp-password-reset",
  apiKey: process.env.RESEND_API_KEY ?? "unused",
  maxAge: 60 * 15,
  async generateVerificationToken() {
    return numericCode();
  },
  async sendVerificationRequest({ identifier: email, token }) {
    await sendMail({
      to: email,
      subject: "Passwort zuruecksetzen",
      html: layout(
        "Passwort zuruecksetzen",
        `<p>Dein Code zum Zuruecksetzen des Passworts:</p>
         <p style="font-size:28px;letter-spacing:6px;font-weight:700">${escapeHtml(token)}</p>
         <p style="color:#666;font-size:13px">Der Code ist 15 Minuten gueltig.
         Wenn du das nicht warst, ignoriere diese Mail.</p>`,
      ),
    });
  },
});

export const ResendOTPVerification = Email({
  id: "resend-otp-verification",
  apiKey: process.env.RESEND_API_KEY ?? "unused",
  maxAge: 60 * 30,
  async generateVerificationToken() {
    return numericCode();
  },
  async sendVerificationRequest({ identifier: email, token }) {
    await sendMail({
      to: email,
      subject: "E-Mail bestaetigen",
      html: layout(
        "E-Mail bestaetigen",
        `<p>Dein Bestaetigungscode:</p>
         <p style="font-size:28px;letter-spacing:6px;font-weight:700">${escapeHtml(token)}</p>
         <p style="color:#666;font-size:13px">Der Code ist 30 Minuten gueltig.</p>`,
      ),
    });
  },
});
