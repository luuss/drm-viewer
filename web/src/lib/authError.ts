export function translateAuthError(
  err: unknown,
  flow: "signIn" | "signUp",
): string {
  const msg = err instanceof Error ? err.message : String(err);

  if (/InvalidSecret/i.test(msg)) return "Falsches Passwort";
  if (/InvalidAccountId|account.*not.*found|no.*such.*account/i.test(msg)) {
    return flow === "signIn"
      ? "Kein Account mit dieser E-Mail gefunden"
      : "Fehler beim Anlegen des Accounts";
  }
  if (/AccountAlreadyExists|already exists/i.test(msg))
    return "Ein Account mit dieser E-Mail existiert bereits";
  if (/TooManyRequests|rate.?limit/i.test(msg))
    return "Zu viele Versuche, bitte kurz warten";
  if (/password.*too.*short|too short/i.test(msg))
    return "Passwort muss mindestens 8 Zeichen haben";
  if (/invalid.*email|email.*invalid/i.test(msg))
    return "E-Mail-Adresse ungültig";
  if (/network|failed to fetch/i.test(msg))
    return "Netzwerkfehler — prüf deine Verbindung";

  return flow === "signIn"
    ? "Login fehlgeschlagen"
    : "Registrierung fehlgeschlagen";
}
