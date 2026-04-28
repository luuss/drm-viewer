import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

export default defineSchema({
  ...authTables,

  books: defineTable({
    title: v.string(),
    filename: v.string(),
    description: v.optional(v.string()),
    coverStorageId: v.optional(v.id("_storage")),
    pdfStorageId: v.id("_storage"),
    pageCount: v.number(),
    pageWidth: v.optional(v.number()),
    pageHeight: v.optional(v.number()),
    priceCents: v.number(),
    currency: v.string(),
    stripePriceId: v.optional(v.string()),
    isPublished: v.boolean(),
    createdAt: v.number(),
  }).index("by_stripe_price", ["stripePriceId"]),

  entitlements: defineTable({
    userId: v.id("users"),
    bookId: v.id("books"),
    source: v.union(
      v.literal("purchase"),
      v.literal("claim"),
      v.literal("admin"),
      v.literal("gift"),
    ),
    stripeSessionId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_book", ["userId", "bookId"])
    .index("by_stripe_session", ["stripeSessionId"]),

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
    .index("by_email", ["email"]),

  readingProgress: defineTable({
    userId: v.id("users"),
    bookId: v.id("books"),
    page: v.number(),
    updatedAt: v.number(),
  }).index("by_user_book", ["userId", "bookId"]),

  purchases: defineTable({
    userId: v.optional(v.id("users")),
    email: v.string(),
    bookId: v.id("books"),
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
    .index("by_user", ["userId"]),

  tileSessions: defineTable({
    userId: v.id("users"),
    sessionToken: v.string(),
    bookId: v.id("books"),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_token", ["sessionToken"])
    .index("by_user_book", ["userId", "bookId"]),
});
