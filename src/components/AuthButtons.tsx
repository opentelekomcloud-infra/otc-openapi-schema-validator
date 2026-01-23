"use client";

import { signIn, signOut, useSession } from "next-auth/react";

export default function AuthButtons() {
  const authEnabled = process.env.NEXT_PUBLIC_ENABLE_AUTH === "true";

  const { data: session, status } = useSession();

  if (!authEnabled) return null;

  if (status === "loading") {
    return (
      <scale-button variant="primary" size="m" disabled>
        Loading…
      </scale-button>
    );
  }

  if (!session) {
    return (
      <scale-button
        onClick={() => signIn("zitadel", { redirectTo: "/" })}
        variant="primary"
        size="m"
      >
        Sign in
      </scale-button>
    );
  }

  return (
    <scale-button
      onClick={() => signOut({ redirectTo: "/" })}
      variant="primary"
      size="m"
    >
      Logout
    </scale-button>
  );
}
