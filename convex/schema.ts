import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

export const entitlementSource = v.union(
  v.literal("purchase"),
  v.literal("claim"),
  v.literal("admin"),
  v.literal("gift"),
  v.literal("subscription"),
);

export default defineSchema({
  ...authTables,

  books: defineTable({
    title: v.string(),
    filename: v.string(),
    description: v.optional(v.string()),
    issueNumber: v.optional(v.string()),
    coverStorageId: v.optional(v.id("_storage")),
    pdfStorageId: v.id("_storage"),
    sourceStorageId: v.optional(v.id("_storage")), // IDML/INDD source
    pageCount: v.number(),
    pageWidth: v.optional(v.number()),
    pageHeight: v.optional(v.number()),
    priceCents: v.number(),
    currency: v.string(),
    stripePriceId: v.optional(v.string()),
    stripeProductId: v.optional(v.string()),
    isPublished: v.boolean(),
    includedInSubscription: v.optional(v.boolean()),
    publishedAt: v.optional(v.number()),
    articleCount: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_stripe_price", ["stripePriceId"])
    .index("by_published", ["isPublished"]),

  entitlements: defineTable({
    userId: v.id("users"),
    bookId: v.id("books"),
    source: entitlementSource,
    stripeSessionId: v.optional(v.string()),
    // null/undefined = unbefristet (Einzelkauf). Gesetzt = Abo-Zugriff bis ...
    validUntil: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_book", ["userId", "bookId"])
    .index("by_stripe_session", ["stripeSessionId"]),

  subscriptionPlans: defineTable({
    name: v.string(),
    description: v.optional(v.string()),
    stripePriceId: v.string(),
    priceCents: v.number(),
    currency: v.string(),
    interval: v.union(v.literal("month"), v.literal("year")),
    isActive: v.boolean(),
    sortOrder: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_stripe_price", ["stripePriceId"]),

  // Gespiegelter Abo-Status: schnelle Zugriffspruefung ohne Stripe-Call.
  subscriptions: defineTable({
    userId: v.id("users"),
    stripeCustomerId: v.string(),
    stripeSubscriptionId: v.string(),
    stripePriceId: v.optional(v.string()),
    status: v.string(), // active | trialing | past_due | canceled | unpaid | incomplete
    currentPeriodEnd: v.optional(v.number()),
    cancelAtPeriodEnd: v.optional(v.boolean()),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_stripe_subscription", ["stripeSubscriptionId"])
    .index("by_stripe_customer", ["stripeCustomerId"]),

  claimTokens: defineTable({
    token: v.string(),
    bookId: v.id("books"),
    email: v.string(),
    createdByUserId: v.optional(v.id("users")),
    stripeSessionId: v.optional(v.string()),
    claimedByUserId: v.optional(v.id("users")),
    claimedAt: v.optional(v.number()),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_email", ["email"])
    .index("by_stripe_session", ["stripeSessionId"])
    .index("by_claimed_by", ["claimedByUserId"]),

  readingProgress: defineTable({
    userId: v.id("users"),
    bookId: v.id("books"),
    page: v.number(),
    articleId: v.optional(v.id("articles")),
    updatedAt: v.number(),
  }).index("by_user_book", ["userId", "bookId"]),

  purchases: defineTable({
    userId: v.optional(v.id("users")),
    email: v.string(),
    bookId: v.optional(v.id("books")),
    planId: v.optional(v.id("subscriptionPlans")),
    stripeSessionId: v.string(),
    stripePaymentIntentId: v.optional(v.string()),
    amountCents: v.number(),
    currency: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("paid"),
      v.literal("failed"),
      v.literal("refunded"),
    ),
    createdAt: v.number(),
  })
    .index("by_stripe_session", ["stripeSessionId"])
    .index("by_payment_intent", ["stripePaymentIntentId"])
    .index("by_user", ["userId"]),

  // Widerrufsverzicht / AGB-Zustimmung, beweissicher protokolliert.
  consents: defineTable({
    userId: v.optional(v.id("users")),
    email: v.optional(v.string()),
    type: v.union(
      v.literal("withdrawal_waiver"),
      v.literal("terms"),
      v.literal("privacy"),
    ),
    documentVersion: v.string(),
    text: v.string(),
    bookId: v.optional(v.id("books")),
    planId: v.optional(v.id("subscriptionPlans")),
    stripeSessionId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_stripe_session", ["stripeSessionId"]),

  tileSessions: defineTable({
    userId: v.id("users"),
    sessionToken: v.string(),
    bookId: v.id("books"),
    lastSeenAt: v.optional(v.number()),
    tileCount: v.optional(v.number()),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_token", ["sessionToken"])
    .index("by_user_book", ["userId", "bookId"])
    .index("by_user", ["userId"]),

  articles: defineTable({
    bookId: v.id("books"),
    order: v.number(),
    title: v.string(),
    subtitle: v.optional(v.string()),
    author: v.optional(v.string()),
    teaser: v.optional(v.string()),
    text: v.string(),
    pageStart: v.number(),
    pageEnd: v.number(),
    // Klickflaechen im Seitenmodus, normiert auf 0..1 relativ zur Seite.
    boxes: v.array(
      v.object({
        page: v.number(),
        x0: v.number(),
        y0: v.number(),
        x1: v.number(),
        y1: v.number(),
      }),
    ),
    images: v.optional(
      v.array(
        v.object({
          storageId: v.id("_storage"),
          page: v.number(),
          caption: v.optional(v.string()),
        }),
      ),
    ),
    source: v.union(
      v.literal("idml"),
      v.literal("pdf"),
      v.literal("manual"),
    ),
    status: v.union(v.literal("draft"), v.literal("published")),
    updatedAt: v.number(),
  })
    .index("by_book", ["bookId"])
    .index("by_book_order", ["bookId", "order"])
    .searchIndex("search_text", {
      searchField: "text",
      filterFields: ["bookId", "status"],
    })
    .searchIndex("search_title", {
      searchField: "title",
      filterFields: ["bookId", "status"],
    }),

  importJobs: defineTable({
    bookId: v.id("books"),
    kind: v.union(v.literal("idml"), v.literal("pdf")),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("done"),
      v.literal("error"),
    ),
    message: v.optional(v.string()),
    progress: v.optional(v.number()),
    articleCount: v.optional(v.number()),
    createdByUserId: v.optional(v.id("users")),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  })
    .index("by_book", ["bookId"])
    .index("by_status", ["status"]),
});
