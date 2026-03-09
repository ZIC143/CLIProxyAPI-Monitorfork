import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { eq, inArray, sql } from "drizzle-orm";
import { config, assertEnv } from "@/lib/config";
import { db } from "@/lib/db/client";
import { authFileMappings, usageRecords } from "@/lib/db/schema";
import { toAuthFileMappings, type AuthFileMappingInsert } from "@/lib/auth-files";
import { parseUsagePayload, toUsageRecords } from "@/lib/usage";

export const runtime = "nodejs";

const PASSWORD = process.env.PASSWORD || process.env.CLIPROXY_SECRET_KEY || "";
const COOKIE_NAME = "dashboard_auth";
const AUTH_FILES_TIMEOUT_MS = 15_000;

function toPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value <= 0) return fallback;
  return value;
}

// 可通过 NEXT_PUBLIC_SYNC_TIMEOUT_MS 环境变量调节（毫秒），默认 120 秒
const USAGE_TIMEOUT_MS = toPositiveInt(process.env.NEXT_PUBLIC_SYNC_TIMEOUT_MS, 120_000);
const AUTH_FILES_INSERT_CHUNK_SIZE = toPositiveInt(process.env.AUTH_FILES_INSERT_CHUNK_SIZE, 500);
const USAGE_INSERT_CHUNK_SIZE = toPositiveInt(process.env.USAGE_INSERT_CHUNK_SIZE, 1000);

function chunkArray<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function missingPassword() {
  return NextResponse.json({ error: "PASSWORD is missing" }, { status: 501 });
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function hashPassword(value: string) {
  const data = new TextEncoder().encode(value);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function isAuthorized(request: Request) {
  // 检查 Bearer token（用于 cron job 等外部调用）
  const allowed = [config.password, config.cronSecret].filter(Boolean).map((v) => `Bearer ${v}`);
  if (allowed.length > 0) {
    const auth = request.headers.get("authorization") || "";
    if (allowed.includes(auth)) return true;
  }

  // 检查用户的 dashboard cookie（用于前端调用）
  if (PASSWORD) {
    const cookieStore = await cookies();
    const authCookie = cookieStore.get(COOKIE_NAME);
    if (authCookie) {
      const expectedToken = await hashPassword(PASSWORD);
      if (authCookie.value === expectedToken) return true;
    }
  }

  return false;
}

function shouldReplaceAuthMapping(existing: AuthFileMappingInsert | undefined, incoming: AuthFileMappingInsert) {
  if (!existing) return true;
  if (incoming.updatedAt && !existing.updatedAt) return true;
  if (incoming.updatedAt && existing.updatedAt && incoming.updatedAt > existing.updatedAt) return true;
  return false;
}

function mergeAuthMapping(existing: AuthFileMappingInsert | undefined, incoming: AuthFileMappingInsert): AuthFileMappingInsert {
  if (!existing) return incoming;

  const updatedAt = (() => {
    if (existing.updatedAt && incoming.updatedAt) {
      return existing.updatedAt > incoming.updatedAt ? existing.updatedAt : incoming.updatedAt;
    }
    return existing.updatedAt ?? incoming.updatedAt ?? null;
  })();

  return {
    authId: existing.authId,
    name: incoming.name?.trim() ? incoming.name : existing.name,
    label: incoming.label?.trim() ? incoming.label : existing.label,
    provider: incoming.provider?.trim() ? incoming.provider : existing.provider,
    source: incoming.source?.trim() ? incoming.source : existing.source,
    email: incoming.email?.trim() ? incoming.email : existing.email,
    updatedAt,
    syncedAt: incoming.syncedAt ?? existing.syncedAt
  };
}

function toProviderMappings(payload: unknown, providerType: "gemini" | "codex" | "claude" | "openai-compatibility", pulledAt: Date): AuthFileMappingInsert[] {
  const obj = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  if (!obj) return [];

  if (providerType === "openai-compatibility") {
    const items = Array.isArray(obj["openai-compatibility"]) ? (obj["openai-compatibility"] as unknown[]) : [];
    const rows: AuthFileMappingInsert[] = [];

    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const node = item as Record<string, unknown>;
      const providerName = String(node.name ?? "").trim();
      const baseUrl = String(node["base-url"] ?? "").trim();
      const keyEntries = Array.isArray(node["api-key-entries"]) ? (node["api-key-entries"] as unknown[]) : [];

      for (const entry of keyEntries) {
        if (!entry || typeof entry !== "object") continue;
        const authId = String((entry as Record<string, unknown>)["api-key"] ?? "").trim();
        if (!authId) continue;
        rows.push({
          authId,
          name: "OpenAI Compatibility",
          label: null,
          provider: providerName || null,
          source: null,
          email: baseUrl || null,
          updatedAt: null,
          syncedAt: pulledAt
        });
      }
    }

    return rows;
  }

  const keyMap: Record<"gemini" | "codex" | "claude", string> = {
    gemini: "gemini-api-key",
    codex: "codex-api-key",
    claude: "claude-api-key"
  };
  const providerNameMap: Record<"gemini" | "codex" | "claude", string> = {
    gemini: "Gemini API Key",
    codex: "Codex API KEY",
    claude: "Claude API KEY"
  };

  const items = Array.isArray(obj[keyMap[providerType]]) ? (obj[keyMap[providerType]] as unknown[]) : [];
  const providerName = providerNameMap[providerType as "gemini" | "codex" | "claude"];

  return items
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const node = item as Record<string, unknown>;
      const authId = String(node["api-key"] ?? "").trim();
      if (!authId) return null;
      const baseUrl = String(node["base-url"] ?? "").trim();

      return {
        authId,
        name: providerName,
        label: null,
        provider: providerName,
        source: null,
        email: baseUrl || null,
        updatedAt: null,
        syncedAt: pulledAt
      } as AuthFileMappingInsert;
    })
    .filter((row): row is AuthFileMappingInsert => Boolean(row));
}

async function syncProviderMappings(project: { id: string; baseUrl: string; apiKey: string }, pulledAt: Date) {
  const endpointTypes = [
    { path: "openai-compatibility", type: "openai-compatibility" as const },
    { path: "gemini-api-key", type: "gemini" as const },
    { path: "codex-api-key", type: "codex" as const },
    { path: "claude-api-key", type: "claude" as const }
  ];

  const rows: AuthFileMappingInsert[] = [];
  let failedEndpoints = 0;

  for (const endpoint of endpointTypes) {
    const url = `${project.baseUrl.replace(/\/$/, "")}/${endpoint.path}`;

    try {
      const response = await fetchWithTimeout(url, {
        headers: {
          Authorization: `Bearer ${project.apiKey}`,
          "Content-Type": "application/json"
        },
        cache: "no-store"
      }, AUTH_FILES_TIMEOUT_MS);

      if (!response.ok) {
        failedEndpoints += 1;
        console.warn("[sync] provider config fetch non-2xx", {
          project: project.id,
          endpoint: endpoint.path,
          status: response.status
        });
        continue;
      }

      const json = await response.json();
      rows.push(...toProviderMappings(json, endpoint.type, pulledAt));
    } catch (error) {
      failedEndpoints += 1;
      const isTimeout = error instanceof Error && error.name === "AbortError";
      console.warn("[sync] provider config fetch failed", {
        project: project.id,
        endpoint: endpoint.path,
        reason: isTimeout ? "timeout" : "error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { rows, failedEndpoints, attemptedEndpoints: endpointTypes.length };
}

async function findMissingAuthIndexes(rows: ReturnType<typeof toUsageRecords>) {
  const authIds = Array.from(
    new Set(rows.map((row) => row.authIndex?.trim()).filter((value): value is string => Boolean(value)))
  );

  if (authIds.length === 0) return [] as string[];

  const existingRows: Array<{ authId: string }> = await db
    .select({ authId: authFileMappings.authId })
    .from(authFileMappings)
    .where(inArray(authFileMappings.authId, authIds));

  const existing = new Set(existingRows.map((row) => row.authId));
  return authIds.filter((id) => !existing.has(id));
}

async function applyAuthMappingsToRows(rows: ReturnType<typeof toUsageRecords>) {
  const authIds = Array.from(
    new Set(
      rows
        .flatMap((row) => [row.authIndex?.trim(), row.email?.trim()])
        .filter((value): value is string => Boolean(value))
    )
  );

  if (authIds.length === 0) return rows;

  const mappingRows: Array<{ authId: string; provider: string | null; email: string | null; name: string }> = await db
    .select({
      authId: authFileMappings.authId,
      provider: authFileMappings.provider,
      email: authFileMappings.email,
      name: authFileMappings.name
    })
    .from(authFileMappings)
    .where(inArray(authFileMappings.authId, authIds));

  const mappingMap = new Map(mappingRows.map((row) => [row.authId, row]));

  return rows.map((row) => {
    const authId = row.authIndex?.trim();
    const emailAsAuthId = row.email?.trim();
    const mapping = (authId ? mappingMap.get(authId) : undefined) ?? (emailAsAuthId ? mappingMap.get(emailAsAuthId) : undefined);
    if (!mapping) return row;

    const mappedProvider = (mapping.provider ?? "").trim();
    const mappedEmail = (mapping.email ?? "").trim() || (mapping.name ?? "").trim();

    return {
      ...row,
      provider: mappedProvider || row.provider,
      email: mappedEmail || row.email
    };
  });
}

async function syncAuthFileMappings(pulledAt: Date) {
  const mergedRows = new Map<string, AuthFileMappingInsert>();
  let failedProjects = 0;
  let failedProviderEndpoints = 0;
  let attemptedProviderEndpoints = 0;

  for (const project of config.cliproxyProjects) {
    const authFilesUrl = `${project.baseUrl.replace(/\/$/, "")}/auth-files`;

    try {
      const response = await fetchWithTimeout(authFilesUrl, {
        headers: {
          Authorization: `Bearer ${project.apiKey}`,
          "Content-Type": "application/json"
        },
        cache: "no-store"
      }, AUTH_FILES_TIMEOUT_MS);

      if (!response.ok) {
        failedProjects += 1;
        console.warn("[sync] auth-files fetch non-2xx", { project: project.id, status: response.status });
        continue;
      }

      const json = await response.json();
      const rows = toAuthFileMappings(json, pulledAt);
      for (const row of rows) {
        const existing = mergedRows.get(row.authId);
        if (shouldReplaceAuthMapping(existing, row)) mergedRows.set(row.authId, row);
        else mergedRows.set(row.authId, mergeAuthMapping(existing, row));
      }
    } catch (error) {
      failedProjects += 1;
      const isTimeout = error instanceof Error && error.name === "AbortError";
      console.warn("[sync] auth-files fetch failed", {
        project: project.id,
        reason: isTimeout ? "timeout" : "error",
        message: error instanceof Error ? error.message : String(error)
      });
    }

    const providerResult = await syncProviderMappings(project, pulledAt);
    failedProviderEndpoints += providerResult.failedEndpoints;
    attemptedProviderEndpoints += providerResult.attemptedEndpoints;
    for (const row of providerResult.rows) {
      const existing = mergedRows.get(row.authId);
      mergedRows.set(row.authId, mergeAuthMapping(existing, row));
    }
  }

  const rows = Array.from(mergedRows.values());
  if (rows.length === 0 && failedProjects > 0) {
    throw new Error("Failed to fetch auth-files from all projects");
  }

  if (rows.length === 0) {
    return {
      synced: 0,
      failedProjects,
      attemptedProjects: config.cliproxyProjects.length,
      failedProviderEndpoints,
      attemptedProviderEndpoints
    };
  }

  for (const chunk of chunkArray(rows, AUTH_FILES_INSERT_CHUNK_SIZE)) {
    await db
      .insert(authFileMappings)
      .values(chunk)
      .onConflictDoUpdate({
        target: authFileMappings.authId,
        set: {
          name: sql`coalesce(nullif(excluded.name, ''), ${authFileMappings.name})`,
          label: sql`coalesce(nullif(excluded.label, ''), ${authFileMappings.label})`,
          provider: sql`coalesce(nullif(excluded.provider, ''), ${authFileMappings.provider})`,
          source: sql`coalesce(nullif(excluded.source, ''), ${authFileMappings.source})`,
          email: sql`coalesce(nullif(excluded.email, ''), ${authFileMappings.email})`,
          updatedAt: sql`coalesce(excluded.updated_at, ${authFileMappings.updatedAt})`,
          syncedAt: pulledAt
        }
      });
  }

  return {
    synced: rows.length,
    failedProjects,
    attemptedProjects: config.cliproxyProjects.length,
    failedProviderEndpoints,
    attemptedProviderEndpoints
  };
}

async function performSync(request: Request) {
  if (!config.password && !config.cronSecret && !PASSWORD) return missingPassword();
  if (!(await isAuthorized(request))) return unauthorized();

  try {
    assertEnv();
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 501 });
  }

  const pulledAt = new Date();
  const allRows: ReturnType<typeof toUsageRecords> = [];

  for (const project of config.cliproxyProjects) {
    const usageUrl = `${project.baseUrl.replace(/\/$/, "")}/usage`;
    let response: Response;

    try {
      response = await fetchWithTimeout(usageUrl, {
        headers: {
          Authorization: `Bearer ${project.apiKey}`,
          "Content-Type": "application/json"
        },
        cache: "no-store"
      }, USAGE_TIMEOUT_MS);
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === "AbortError";
      console.warn("[sync] usage fetch failed", {
        project: project.id,
        reason: isTimeout ? "timeout" : "error",
        message: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    if (!response.ok) {
      console.warn("[sync] usage fetch non-2xx", { project: project.id, status: response.status });
      continue;
    }

    try {
      const json = await response.json();
      const payload = parseUsagePayload(json);
      const rows = toUsageRecords(payload, pulledAt, project.id);
      allRows.push(...rows);
    } catch (parseError) {
      console.warn("/api/sync parse upstream usage failed:", { project: project.id, parseError });
    }
  }

  let authFilesSynced = 0;
  let unmatchedAuthIndexesBefore = 0;
  let unmatchedAuthIndexesAfter = 0;
  let authFilesSyncTriggered = false;
  let authFilesWarning: string | undefined;

  if (allRows.length > 0) {
    const missingBefore = await findMissingAuthIndexes(allRows);
    unmatchedAuthIndexesBefore = missingBefore.length;

    if (missingBefore.length > 0) {
      authFilesSyncTriggered = true;
      try {
        const authFilesResult = await syncAuthFileMappings(pulledAt);
        authFilesSynced = authFilesResult.synced;

        const warnings: string[] = [];
        if (authFilesResult.failedProjects > 0) {
          warnings.push(`auth-files partial sync failed (${authFilesResult.failedProjects}/${authFilesResult.attemptedProjects})`);
        }
        if (authFilesResult.failedProviderEndpoints > 0) {
          warnings.push(`provider partial sync failed (${authFilesResult.failedProviderEndpoints}/${authFilesResult.attemptedProviderEndpoints})`);
        }
        if (warnings.length > 0) authFilesWarning = warnings.join("; ");
      } catch (error) {
        const isTimeout = error instanceof Error && error.name === "AbortError";
        authFilesWarning = isTimeout ? "auth-files sync timed out" : "auth-files sync failed";
        console.warn("/api/sync auth-files sync failed:", error);
      }

      const missingAfter = await findMissingAuthIndexes(allRows);
      unmatchedAuthIndexesAfter = missingAfter.length;
    }
  }

  const primaryProjectId = config.primaryProject?.id || "";
  if (primaryProjectId) {
    await db
      .update(usageRecords)
      .set({ project: primaryProjectId })
      .where(sql`${usageRecords.project} = '' OR ${usageRecords.project} IS NULL`);
  }

  if (allRows.length === 0) {
    return NextResponse.json({
      status: "ok",
      inserted: 0,
      message: "No usage data",
      authFilesSynced,
      authFilesSyncTriggered,
      unmatchedAuthIndexesBefore,
      unmatchedAuthIndexesAfter,
      ...(authFilesWarning ? { authFilesWarning } : {})
    });
  }

  const rowsToInsert = await applyAuthMappingsToRows(allRows);

  let inserted = 0;
  try {
    for (const chunk of chunkArray(rowsToInsert, USAGE_INSERT_CHUNK_SIZE)) {
      const insertedRows = await db
        .insert(usageRecords)
        .values(chunk)
        .onConflictDoNothing({ target: [usageRecords.occurredAt, usageRecords.project, usageRecords.route, usageRecords.model, usageRecords.email] })
        .returning({ id: usageRecords.id });
      inserted += insertedRows.length;
    }
  } catch (dbError) {
    console.error("/api/sync database insert failed:", dbError);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }

  // Vercel Postgres may return an empty array even when rows are inserted with RETURNING + ON CONFLICT DO NOTHING.
  // Fall back to counting rows synced in this run (identified by the shared pulledAt timestamp) to avoid reporting 0.
  if (inserted === 0 && rowsToInsert.length > 0) {
    const fallback = await db
      .select({ count: sql<number>`count(*)` })
      .from(usageRecords)
      .where(eq(usageRecords.syncedAt, pulledAt));
    inserted = Number(fallback?.[0]?.count ?? 0);
  }

  return NextResponse.json({
    status: "ok",
    inserted,
    attempted: rowsToInsert.length,
    authFilesSynced,
    authFilesSyncTriggered,
    unmatchedAuthIndexesBefore,
    unmatchedAuthIndexesAfter,
    ...(authFilesWarning ? { authFilesWarning } : {})
  });
}

export async function POST(request: Request) {
  return performSync(request);
}

export async function GET(request: Request) {
  return performSync(request);
}
