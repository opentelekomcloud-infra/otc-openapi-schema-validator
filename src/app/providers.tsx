"use client";

import React, { createContext, useContext } from "react";
import { SessionProvider } from "next-auth/react";

const AuthEnabledContext = createContext<boolean>(false);

export function useAuthEnabled(): boolean {
  return useContext(AuthEnabledContext);
}

export default function Providers({
                                    children,
                                    authEnabled,
                                  }: {
  children: React.ReactNode;
  authEnabled: boolean;
}) {
  return (
    <AuthEnabledContext.Provider value={authEnabled}>
      {authEnabled ? <SessionProvider>{children}</SessionProvider> : <>{children}</>}
    </AuthEnabledContext.Provider>);
}
