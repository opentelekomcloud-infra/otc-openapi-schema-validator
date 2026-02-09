"use client";

import { signIn, signOut, useSession } from "next-auth/react";
import { useAuthEnabled } from "@/app/providers";

export default function AuthButtons() {
  const authEnabled = useAuthEnabled();

  if (!authEnabled) return null;
  return <AuthButtonsInner />;
}

function AuthButtonsInner() {
  const { data: session, status } = useSession();

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
