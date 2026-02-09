import { NextResponse } from "next/server";
import { config, assertEnv } from "@/lib/config";

export const runtime = "nodejs";

function endpoint() {
  return `${config.cliproxy.baseUrl.replace(/\/$/, "")}/usage-statistics-enabled`;
}

function authHeaders() {
  return {
    Authorization: `Bearer ${config.cliproxy.apiKey}`,
    "Content-Type": "application/json"
  };
}

let usageStatsCache: { value: boolean; updatedAt: number } | null = null;

async function fetchWithTimeoutAndRetry(url: string, init?: RequestInit, timeoutMs = 8_000, retries = 1) {
  let lastError: unknown;
  for (let i = 0; i <= retries; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      lastError = error;
      if (i === retries) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function handleToggle(request: Request) {
  try {
    assertEnv();
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 501 });
  }

  try {
    const body = await request.json().catch(() => null);
    const value = typeof body?.value === "boolean" ? body.value : null;
    if (value === null) {
      return NextResponse.json({ error: "Missing boolean 'value'" }, { status: 400 });
    }

    const res = await fetchWithTimeoutAndRetry(endpoint(), {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ value })
    });

    if (!res.ok) {
      return NextResponse.json({ error: res.statusText }, { status: res.status });
    }
    usageStatsCache = { value, updatedAt: Date.now() };
    return NextResponse.json({ "usage-statistics-enabled": value }, { status: 200 });
  } catch (error) {
    console.error("/api/usage-statistics-enabled POST failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function GET() {
  try {
    assertEnv();
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 501 });
  }

  try {
    const res = await fetchWithTimeoutAndRetry(endpoint(), { headers: authHeaders(), cache: "no-store" });
    if (!res.ok) {
      return NextResponse.json({ error: res.statusText }, { status: res.status });
    }
    const data = await res.json();
    const enabled = Boolean(data?.["usage-statistics-enabled"]);
    usageStatsCache = { value: enabled, updatedAt: Date.now() };
    return NextResponse.json(data, { status: 200 });
  } catch (error) {
    console.error("/api/usage-statistics-enabled GET failed:", error);
    if (usageStatsCache) {
      return NextResponse.json(
        {
          "usage-statistics-enabled": usageStatsCache.value,
          stale: true,
          degraded: true,
          updatedAt: usageStatsCache.updatedAt
        },
        { status: 200 }
      );
    }
    return NextResponse.json({ "usage-statistics-enabled": false, stale: true, degraded: true }, { status: 200 });
  }
}

export async function POST(request: Request) {
  return handleToggle(request);
}

export async function PATCH(request: Request) {
  return handleToggle(request);
}

export async function PUT(request: Request) {
  return handleToggle(request);
}
