/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as account from "../account.js";
import type * as articles from "../articles.js";
import type * as assets from "../assets.js";
import type * as auth from "../auth.js";
import type * as billing from "../billing.js";
import type * as claims from "../claims.js";
import type * as consents from "../consents.js";
import type * as crons from "../crons.js";
import type * as devtools from "../devtools.js";
import type * as email from "../email.js";
import type * as entitlements from "../entitlements.js";
import type * as http from "../http.js";
import type * as imports from "../imports.js";
import type * as issuePages from "../issuePages.js";
import type * as issueSources from "../issueSources.js";
import type * as issues from "../issues.js";
import type * as mail from "../mail.js";
import type * as migrations from "../migrations.js";
import type * as otp from "../otp.js";
import type * as plans from "../plans.js";
import type * as progress from "../progress.js";
import type * as publicationCovers from "../publicationCovers.js";
import type * as publications from "../publications.js";
import type * as purchases from "../purchases.js";
import type * as readerSessions from "../readerSessions.js";
import type * as roles from "../roles.js";
import type * as serviceAuth from "../serviceAuth.js";
import type * as shopCovers from "../shopCovers.js";
import type * as shopIntegration from "../shopIntegration.js";
import type * as stripeEvents from "../stripeEvents.js";
import type * as subscriptionCatalog from "../subscriptionCatalog.js";
import type * as subscriptions from "../subscriptions.js";
import type * as toc from "../toc.js";
import type * as uploadRules from "../uploadRules.js";
import type * as uploads from "../uploads.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  account: typeof account;
  articles: typeof articles;
  assets: typeof assets;
  auth: typeof auth;
  billing: typeof billing;
  claims: typeof claims;
  consents: typeof consents;
  crons: typeof crons;
  devtools: typeof devtools;
  email: typeof email;
  entitlements: typeof entitlements;
  http: typeof http;
  imports: typeof imports;
  issuePages: typeof issuePages;
  issueSources: typeof issueSources;
  issues: typeof issues;
  mail: typeof mail;
  migrations: typeof migrations;
  otp: typeof otp;
  plans: typeof plans;
  progress: typeof progress;
  publicationCovers: typeof publicationCovers;
  publications: typeof publications;
  purchases: typeof purchases;
  readerSessions: typeof readerSessions;
  roles: typeof roles;
  serviceAuth: typeof serviceAuth;
  shopCovers: typeof shopCovers;
  shopIntegration: typeof shopIntegration;
  stripeEvents: typeof stripeEvents;
  subscriptionCatalog: typeof subscriptionCatalog;
  subscriptions: typeof subscriptions;
  toc: typeof toc;
  uploadRules: typeof uploadRules;
  uploads: typeof uploads;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  stripe: import("@convex-dev/stripe/_generated/component.js").ComponentApi<"stripe">;
};
