import NextAuth from "next-auth";
import Zitadel from "next-auth/providers/zitadel";

export const isAuthEnabled = process.env.ENABLE_AUTH === "true";

export const authConfig = {
  providers: isAuthEnabled
    ? [
      Zitadel({
        issuer: process.env.AUTH_ZITADEL_ISSUER,
        clientId: process.env.AUTH_ZITADEL_ID,
      }),
    ]
    : [],
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account) {
        token.accessToken = account.access_token;
        token.idToken = account.id_token;
        token.provider = account.provider;
      }
      // Useful to have a stable subject if needed
      if (profile && typeof profile === "object" && "sub" in profile) {
        token.sub = (profile as any).sub;
      }
      return token;
    },
    async session({ session, token }) {
      (session as any).accessToken = (token as any).accessToken;
      (session as any).idToken = (token as any).idToken;
      return session;
    },
  },
} satisfies Parameters<typeof NextAuth>[0];

export const { auth, handlers, signIn, signOut } = NextAuth(authConfig);
