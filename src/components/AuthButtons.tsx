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
      <scale-button variant="secondary" disabled>
        Loading…
      </scale-button>
    );
  }

  if (!session) {
    return (
      <scale-button
        onClick={() => signIn("zitadel", { redirectTo: "/" })}
        variant="secondary"
      >
        Sign in
      </scale-button>
    );
  }

  return (
    <scale-button
      onClick={() => signOut({ redirectTo: "/" })}
      variant="secondary"
    >
      Logout
    </scale-button>
  );
}
