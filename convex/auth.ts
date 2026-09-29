import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { convexAuth } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { MutationCtx } from "./_generated/server";
import { looksLikeToken } from "./magicLinkRules";
import { makeRoomForLogin } from "./sessions";

/**
 * Anmeldung nur per E-Mail-Link (magicLink.ts). Passwoerter gibt es nicht
 * mehr. Die alten `password`-Konten bleiben in `authAccounts` liegen, koennen
 * aber nicht mehr anmelden, weil der Provider fehlt.
 */
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    ConvexCredentials({
      id: "magic-link",
      authorize: async (params, ctx) => {
        if (!looksLikeToken(params.token)) {
          throw new ConvexError({ grund: "unbekannt" });
        }
        const { userId }: { userId: Id<"users">; next: string } = await ctx.runMutation(
          internal.magicLink.consumeInternal,
          { token: params.token },
        );
        return { userId };
      },
    }),
  ],
  session: {
    // Wer nicht liest, muss nach 30 Tagen wieder einen Link anfordern,
    // spaetestens nach 90 Tagen jeder.
    totalDurationMs: 90 * 24 * 60 * 60 * 1000,
    inactiveDurationMs: 30 * 24 * 60 * 60 * 1000,
  },
  jwt: {
    // Kurz, damit ein beendeter Browser schnell ausgesperrt ist, auch wenn er
    // das Abmeldesignal (sessions.current) ignoriert.
    durationMs: 15 * 60 * 1000,
  },
  callbacks: {
    // Hoechstens zwei angemeldete Browser: die aeltesten weichen.
    async beforeSessionCreation(ctx, { userId }) {
      await makeRoomForLogin(ctx as unknown as MutationCtx, userId as Id<"users">);
    },
  },
});
