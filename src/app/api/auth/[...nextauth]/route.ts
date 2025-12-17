import { handlers, isAuthEnabled } from "@/lib/auth";
import {NextRequest, NextResponse} from "next/server";

export const runtime = "nodejs";

export const GET = async (req: NextRequest) => {
  if (!isAuthEnabled) {
    return NextResponse.json({ error: "Auth disabled" }, { status: 404 });
  }
  if (!handlers?.GET) {
    return NextResponse.json(
      {
        error: "Auth misconfigured",
        message:
          "NextAuth handlers are undefined.",
      },
      { status: 500 }
    );
  }
  return handlers.GET(req);
};

export const POST = async (req: NextRequest) => {
  if (!isAuthEnabled) {
    return NextResponse.json({ error: "Auth disabled" }, { status: 404 });
  }
  if (!handlers?.POST) {
    return NextResponse.json(
      {
        error: "Auth misconfigured",
        message:
          "NextAuth handlers are undefined.",
      },
      { status: 500 }
    );
  }
  return handlers.POST(req);
};
