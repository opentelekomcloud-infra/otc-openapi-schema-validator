"use client";

import { signIn, signOut, useSession } from "next-auth/react";

export default function AuthButtons() {
  if (process.env.NEXT_PUBLIC_ENABLE_AUTH !== "true") {
    return null;
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { data: session, status } = useSession();

  if (status === "loading") return null;

  if (!session) {
    return (
      <button
        onClick={() => signIn("zitadel", { redirectTo: "/" })}
        className="px-3 py-1 border rounded"
      >
        Sign in
      </button>
    );
  }

  return (
    <button
      onClick={() => signOut({ redirectTo: "/" })}
      className="px-3 py-1 border rounded"
    >
      Logout
    </button>
  );
}
