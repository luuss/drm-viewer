import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

export const entitlementSource = v.union(
  v.literal("purchase"),
  v.literal("claim"),
  v.literal("admin"),
  v.literal("gift"),
  v.literal("subscription"),
  v.literal("external_shop"),
);

export const pageRole = v.union(
  v.literal("front_cover"),
  v.literal("inside_front"),
  v.literal("content"),
  v.literal("inside_back"),
  v.literal("back_cover"),
  v.literal("other"),
);

export const blockType = v.union(
  v.literal("heading"),
  v.literal("subheading"),
  v.literal("lead"),
  v.literal("paragraph"),
  v.literal("quote"),
  v.literal("caption"),
  v.literal("box"),
  v.literal("other"),
);

export const regionBox = {
  x0: v.number(),
  y0: v.number(),
  x1: v.number(),
  y1: v.number(),
};

export default defineSchema(
  {
    ...authTables,

  // Rollen haengen am Nutzer; ADMIN_EMAILS dient nur noch dem ersten Zugang.
  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    roles: v.optional(v.array(v.string())),
  }).index("email", ["email"]),

  publications: defineTable({
    name: v.string(),
    slug: v.string(),
    description: v.optional(v.string()),
    isActive: v.boolean(),
    createdAt: v.number(),
  }).index("by_slug", ["slug"]),

  issues: defineTable({
    publicationId: v.id("publications"),
    title: v.string(),
    slug: v.string(),
    issueNumber: v.optional(v.string()),
    publicationDate: v.optional(v.number()),
    description: v.optional(v.string()),
    coverAssetId: v.optional(v.id("assets")),
    pageCount: v.number(),
    // Verbindliche, commerce-neutrale Preisquelle. Das MVP fuehrt nur EUR.
    priceAmountCents: v.number(),
    externalSku: v.optional(v.string()),
    stripePriceId: v.optional(v.string()),
    stripeProductId: v.optional(v.string()),
    isPublished: v.boolean(),
    includedInSubscription: v.boolean(),
    publishedAt: v.optional(v.number()),
    articleCount: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_publication", ["publicationId"])
    .index("by_slug", ["slug"])
    .index("by_published", ["isPublished"])
    .index("by_external_sku", ["externalSku"])
    .index("by_stripe_price", ["stripePriceId"]),

  /**
   * Eintrag im Objektspeicher. `key` ist die Adresse im Bucket. Solange kein
   * S3 eingerichtet ist, liegt die Datei in der Convex-Ablage und
   * `convexStorageId` verweist darauf — das Datenmodell bleibt gleich.
   */
  assets: defineTable({
    key: v.string(),
    bucket: v.optional(v.string()),
    contentType: v.string(),
    bytes: v.optional(v.number()),
    kind: v.union(
      v.literal("source"),
      v.literal("page"),
      v.literal("tile"),
      v.literal("image"),
      v.literal("cover"),
    ),
    issueId: v.optional(v.id("issues")),
    convexStorageId: v.optional(v.id("_storage")),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_issue", ["issueId"]),

  issueSources: defineTable({
    issueId: v.id("issues"),
    kind: v.union(v.literal("pdf"), v.literal("idml"), v.literal("indd")),
    role: v.union(
      v.literal("inner"),
      v.literal("cover"),
      v.literal("supplemental"),
      v.literal("archive"),
    ),
    assetId: v.id("assets"),
    filename: v.string(),
    pageCount: v.optional(v.number()),
    sortOrder: v.number(),
    createdAt: v.number(),
  }).index("by_issue", ["issueId"]),

  issuePages: defineTable({
    issueId: v.id("issues"),
    index: v.number(),
    printedLabel: v.optional(v.string()),
    role: pageRole,
    sourceAssetId: v.id("assets"),
    sourcePageIndex: v.number(),
    width: v.number(),
    height: v.number(),
    tileManifestKey: v.optional(v.string()),
    previewKey: v.optional(v.string()),
  })
    .index("by_issue", ["issueId"])
    .index("by_issue_index", ["issueId", "index"]),

  articles: defineTable({
    issueId: v.id("issues"),
    order: v.number(),
    title: v.string(),
    subtitle: v.optional(v.string()),
    author: v.optional(v.string()),
    teaser: v.optional(v.string()),
    source: v.union(
      v.literal("idml"),
      v.literal("pdf"),
      v.literal("manual"),
      v.literal("hybrid"),
    ),
    // Artikel werden nicht einzeln veroeffentlicht. Sichtbar werden
    // freigegebene Artikel durch die Veroeffentlichung ihrer Ausgabe.
    reviewStatus: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("excluded"),
    ),
    confidence: v.optional(v.number()),
    primaryPageIndex: v.number(),
    pageStart: v.number(),
    pageEnd: v.number(),
    searchText: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_issue", ["issueId"])
    .index("by_issue_order", ["issueId", "order"])
    .searchIndex("search_text", {
      searchField: "searchText",
      filterFields: ["issueId", "reviewStatus"],
    }),

  articleBlocks: defineTable({
    articleId: v.id("articles"),
    issueId: v.id("issues"),
    order: v.number(),
    type: blockType,
    text: v.string(),
    sourcePageIndex: v.optional(v.number()),
    sourceStoryId: v.optional(v.string()),
    sourceFrameId: v.optional(v.string()),
    styleName: v.optional(v.string()),
    confidence: v.optional(v.number()),
  })
    .index("by_article", ["articleId"])
    .index("by_article_order", ["articleId", "order"])
    .index("by_issue", ["issueId"]),

  articleRegions: defineTable({
    articleId: v.id("articles"),
    issueId: v.id("issues"),
    pageIndex: v.number(),
    ...regionBox,
    kind: v.union(
      v.literal("body"),
      v.literal("title"),
      v.literal("image"),
      v.literal("other"),
    ),
    order: v.optional(v.number()),
  })
    .index("by_article", ["articleId"])
    .index("by_issue", ["issueId"])
    .index("by_issue_page", ["issueId", "pageIndex"]),

  articleAssets: defineTable({
    articleId: v.id("articles"),
    issueId: v.id("issues"),
    assetId: v.id("assets"),
    order: v.number(),
    caption: v.optional(v.string()),
    sourcePageIndex: v.optional(v.number()),
  })
    .index("by_article", ["articleId"])
    .index("by_issue", ["issueId"]),

  tocEntries: defineTable({
    issueId: v.id("issues"),
    order: v.number(),
    label: v.string(),
    section: v.optional(v.string()),
    pageIndex: v.optional(v.number()),
    articleId: v.optional(v.id("articles")),
    level: v.number(),
  })
    .index("by_issue", ["issueId"])
    .index("by_issue_order", ["issueId", "order"]),

  entitlements: defineTable({
    userId: v.id("users"),
    issueId: v.id("issues"),
    source: entitlementSource,
    stripeSessionId: v.optional(v.string()),
    externalOrderId: v.optional(v.string()),
    subscriptionId: v.optional(v.id("subscriptions")),
    validFrom: v.optional(v.number()),
    validUntil: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_issue", ["userId", "issueId"])
    .index("by_issue", ["issueId"])
    .index("by_stripe_session", ["stripeSessionId"])
    .index("by_external_order", ["externalOrderId"]),

  subscriptionPlans: defineTable({
    name: v.string(),
    description: v.optional(v.string()),
    publicationId: v.id("publications"),
    stripePriceId: v.string(),
    priceAmountCents: v.number(),
    interval: v.union(v.literal("month"), v.literal("year")),
    isActive: v.boolean(),
    sortOrder: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_stripe_price", ["stripePriceId"]),

  subscriptions: defineTable({
    userId: v.id("users"),
    stripeCustomerId: v.string(),
    stripeSubscriptionId: v.string(),
    stripePriceId: v.optional(v.string()),
    publicationId: v.optional(v.id("publications")),
    status: v.string(),
    // Ausdrueckliche Zeitraeume: ohne sie liesse sich nach einer Pause nicht
    // entscheiden, welche Hefte dazwischen nicht dazugehoeren.
    startedAt: v.number(),
    currentPeriodEnd: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    cancelAtPeriodEnd: v.optional(v.boolean()),
    lastSyncedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_stripe_subscription", ["stripeSubscriptionId"])
    .index("by_stripe_customer", ["stripeCustomerId"]),

  claimTokens: defineTable({
    token: v.string(),
    issueId: v.id("issues"),
    email: v.string(),
    createdByUserId: v.optional(v.id("users")),
    stripeSessionId: v.optional(v.string()),
    externalOrderId: v.optional(v.string()),
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
    issueId: v.id("issues"),
    mode: v.union(v.literal("page"), v.literal("article")),
    pageIndex: v.number(),
    articleId: v.optional(v.id("articles")),
    updatedAt: v.number(),
  }).index("by_user_issue", ["userId", "issueId"]),

  purchases: defineTable({
    userId: v.optional(v.id("users")),
    email: v.string(),
    issueId: v.optional(v.id("issues")),
    planId: v.optional(v.id("subscriptionPlans")),
    stripeSessionId: v.string(),
    stripePaymentIntentId: v.optional(v.string()),
    amountCents: v.number(),
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
    issueId: v.optional(v.id("issues")),
    planId: v.optional(v.id("subscriptionPlans")),
    stripeSessionId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_stripe_session", ["stripeSessionId"]),

  readerSessions: defineTable({
    userId: v.id("users"),
    sessionToken: v.string(),
    issueId: v.id("issues"),
    lastSeenAt: v.optional(v.number()),
    tileCount: v.optional(v.number()),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_token", ["sessionToken"])
    .index("by_user_issue", ["userId", "issueId"])
    .index("by_user", ["userId"]),

  importJobs: defineTable({
    issueId: v.id("issues"),
    kind: v.union(
      v.literal("prepare"),
      v.literal("pdf"),
      v.literal("idml"),
      v.literal("full"),
    ),
    status: v.union(
      v.literal("queued"),
      v.literal("claimed"),
      v.literal("running"),
      v.literal("review"),
      v.literal("done"),
      v.literal("error"),
    ),
    payload: v.optional(v.string()),
    progress: v.optional(v.number()),
    message: v.optional(v.string()),
    attempts: v.number(),
    leaseUntil: v.optional(v.number()),
    workerId: v.optional(v.string()),
    createdByUserId: v.optional(v.id("users")),
    createdAt: v.number(),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
  })
    .index("by_issue", ["issueId"])
    .index("by_status", ["status"]),

  shopGrants: defineTable({
    externalOrderId: v.string(),
    externalCustomerId: v.optional(v.string()),
    email: v.string(),
    action: v.union(v.literal("grant"), v.literal("revoke")),
    issueId: v.optional(v.id("issues")),
    issueSku: v.optional(v.string()),
    result: v.string(),
    createdAt: v.number(),
  })
    .index("by_order_action", ["externalOrderId", "action"])
    .index("by_email", ["email"]),

  auditLog: defineTable({
    actorUserId: v.optional(v.id("users")),
    actorEmail: v.optional(v.string()),
    action: v.string(),
    target: v.optional(v.string()),
    detail: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_action", ["action"])
    .index("by_actor", ["actorUserId"]),
  },
  // Die Altbestaende sind migriert und entfernt, das Schema gilt wieder streng.
  { schemaValidation: true },
);

