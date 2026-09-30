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

/**
 * Taeglich Preis, Adresse und Verfuegbarkeit der Produkte nachfuehren, auf die
 * Anzeigen im Heft zeigen, und offene Anzeigen juengerer Hefte erneut versuchen.
 */
crons.cron(
  "buchanzeigen mit dem laden abgleichen",
  "45 4 * * *",
  internal.articleProducts.refreshInternal,
  {},
);

/** Anmeldelinks aelter als ein Tag loeschen (gueltig sind sie nur 15 min). */
crons.interval("anmeldelinks aufraeumen", { hours: 6 }, internal.magicLink.cleanupInternal, {});

export default crons;
