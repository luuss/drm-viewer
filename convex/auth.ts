import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import { DataModel } from "./_generated/dataModel";
import { ResendOTPPasswordReset, ResendOTPVerification } from "./otp";

/**
 * E-Mail-Bestaetigung ist optional schaltbar (REQUIRE_EMAIL_VERIFICATION=true),
 * damit bestehende Konten nicht ploetzlich ausgesperrt werden.
 */
const requireVerification = process.env.REQUIRE_EMAIL_VERIFICATION === "true";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password<DataModel>({
      reset: ResendOTPPasswordReset,
      verify: requireVerification ? ResendOTPVerification : undefined,
      validatePasswordRequirements: (password: string) => {
        if (password.length < 10) {
          throw new Error("Passwort muss mindestens 10 Zeichen haben");
        }
        if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
          throw new Error("Passwort braucht Buchstaben und Ziffern");
        }
      },
      profile(params) {
        const email = String(params.email ?? "").trim().toLowerCase();
        return { email };
      },
    }),
  ],
});
