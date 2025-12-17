import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/lib/auth";

export async function middleware(req: NextRequest) {
  // Auth disabled → allow everything
  if (process.env.ENABLE_AUTH !== "true") {
    return NextResponse.next();
  }

  const session = await auth();

  const { pathname } = req.nextUrl;

  const isPublicAsset =
    pathname.startsWith("/images/") ||
    pathname.startsWith("/lib/") ||
    pathname.startsWith("/gitea/") ||
    pathname === "/favicon.ico" ||
    /\.(png|jpg|jpeg|gif|svg|webp|ico|css|js|map|txt|xml)$/.test(pathname);

  if (isPublicAsset) {
    return NextResponse.next();
  }
  // Allow Auth.js endpoints always
  if (pathname.startsWith("/api/auth")) {
    return NextResponse.next();
  }

  // Not logged in → redirect to signin
  if (!session) {
    const signinUrl = new URL("/api/auth/signin", req.url);
    signinUrl.searchParams.set(
      "callbackUrl",
      req.nextUrl.pathname + req.nextUrl.search
    );
    return NextResponse.redirect(signinUrl);
  }

  // Logged in → allow
  return NextResponse.next();
}

// Protect everything except static files
export const config = {
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|images/).*)"],
};
