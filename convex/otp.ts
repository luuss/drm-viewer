import { Email } from "@convex-dev/auth/providers/Email";
import { sendMail, layout, escapeHtml } from "./mail";

/** 8-stelliger Zahlencode. Keine Zusatz-Abhaengigkeit noetig. */
function numericCode(length = 8): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => (b % 10).toString())
    .join("");
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
