import { NextResponse } from "next/server";
import { assertEnv } from "@/lib/config";
import { getUsageRecords, type SortKey } from "@/lib/queries/records";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    assertEnv();
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 501 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const limitParam = searchParams.get("limit");
    const VALID_SORT_FIELDS = new Set(["occurredAt", "model", "route", "source", "totalTokens", "inputTokens", "outputTokens", "reasoningTokens", "cachedTokens", "cost", "isError"]);
    const sortParam = searchParams.get("sort");
    let sortKeys: SortKey[] | undefined;
    if (sortParam) {
      const parsed = sortParam.split(",").map(part => {
        const [f, o] = part.split(":");
        return { field: (f ?? "").trim(), order: (o ?? "desc").trim() };
      }).filter(k => VALID_SORT_FIELDS.has(k.field) && (k.order === "asc" || k.order === "desc")) as SortKey[];
      if (parsed.length > 0) sortKeys = parsed;
    }
    // Legacy fallback
    const legacySortField = searchParams.get("sortField");
    const legacySortOrder = searchParams.get("sortOrder");
    const sortField = !sortKeys && legacySortField && VALID_SORT_FIELDS.has(legacySortField) ? legacySortField as SortKey["field"] : undefined;
    const sortOrder = !sortKeys && (legacySortOrder === "asc" || legacySortOrder === "desc") ? legacySortOrder : undefined;
    const cursor = searchParams.get("cursor");
    const project = searchParams.get("project");
    const model = searchParams.get("model");
    const route = searchParams.get("route");
    const source = searchParams.get("source");
    const start = searchParams.get("start");
    const end = searchParams.get("end");
    const includeFilters = searchParams.get("includeFilters") === "1";

    const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;

    const payload = await getUsageRecords({
      limit,
      sortKeys,
      sortField,
      sortOrder,
      cursor,
      project: project || undefined,
      model: model || undefined,
      route: route || undefined,
      source: source || undefined,
      start,
      end,
      includeFilters
    });

    return NextResponse.json(payload, { status: 200 });
  } catch (error) {
    console.error("/api/records failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}