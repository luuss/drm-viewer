import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

/**
 * Taeglicher Abgleich der Abos. Faellt ein Webhook aus, holt der Lauf die
 * fehlenden Freischaltungen nach; er entzieht nie etwas.
 */
crons.daily(
  "abos abgleichen",
  { hourUTC: 2, minuteUTC: 30 },
  internal.subscriptions.syncAllInternal,
  {},
);

/**
 * Taeglich das aktuelle Titelbild jeder Reihe aus dem Verlagsshop holen; es
 * steht auf den Abo-Karten und Abo-Seiten.
 */
crons.daily(
  "titelbilder aus dem verlagsshop",
  { hourUTC: 4, minuteUTC: 15 },
  internal.publicationCovers.refreshAll,
  {},
);

export default crons;
