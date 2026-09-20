/** Mailversand ueber Resend. Ohne API-Key wird nur geloggt (lokale Entwicklung). */
export async function sendMail(args: {
  to: string;
  subject: string;
  html: string;
}): Promise<{ ok: boolean; stubbed: boolean }> {
  const apiKey = process.env.RESEND_API_KEY;
  const from =
    process.env.RESEND_FROM_EMAIL ?? "E-Magazin <noreply@example.com>";

  if (!apiKey) {
    console.log(`[mail:stub] an ${args.to}: ${args.subject}`);
    return { ok: true, stubbed: true };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: args.to,
      subject: args.subject,
      html: args.html,
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend failed: ${res.status} ${await res.text()}`);
  }
  return { ok: true, stubbed: false };
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function layout(heading: string, bodyHtml: string): string {
  return `
    <div style="font-family:sans-serif;max-width:540px;margin:auto;padding:24px">
      <h2 style="color:#e94560">${escapeHtml(heading)}</h2>
      ${bodyHtml}
    </div>`;
}

export function appUrl(): string {
  return (process.env.APP_PUBLIC_URL ?? "http://localhost:5173").replace(
    /\/$/,
    "",
  );
}
