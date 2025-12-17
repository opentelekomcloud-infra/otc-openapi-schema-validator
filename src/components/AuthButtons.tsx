"use client";

import { signIn, signOut, useSession } from "next-auth/react";

export default function AuthButtons() {
  const authEnabled = process.env.NEXT_PUBLIC_ENABLE_AUTH === "true";

  if (!authEnabled) {
    return null;
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { data: session, status } = useSession();

  if (status === "loading") return null;

  if (!session && authEnabled) {
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

  if (session && authEnabled) {
    return (
      <scale-button onClick={() => signOut({ redirectTo: "/" })} variant="primary" size="m">
        Logout
      </scale-button>
    );
  }

  return null;
}
