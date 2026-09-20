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

export default crons;
