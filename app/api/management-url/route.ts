import { NextResponse } from "next/server";
import { config } from "@/lib/config";

export const runtime = "nodejs";

function buildManagementUrl() {
  return config.primaryProject?.managementUrl || null;
}

export async function GET() {
  const url = buildManagementUrl();
  if (!url) {
    return NextResponse.json({ error: "CLIPROXY_API_BASE_URL(S) is missing" }, { status: 501 });
  }
  return NextResponse.json({ url });
}
