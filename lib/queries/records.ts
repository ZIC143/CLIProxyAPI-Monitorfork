import * as DrizzleOrm from "drizzle-orm";
const { and, asc, desc, eq, gte, lte, sql } = DrizzleOrm as any;
import { db } from "@/lib/db/client";
import { modelPrices, usageRecords } from "@/lib/db/schema";
import { estimateCost, priceMap } from "@/lib/usage";

export type UsageRecordRow = {
  id: number;
  occurredAt: Date;
  route: string;
  source: string;
  credentialName: string;
  provider: string;
  model: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  isError: boolean;
  cost: number;
};

export type UsageRecordCursor = {
  lastValue: string | number;
  lastId: number;
};

type SortField =
  | "occurredAt"
  | "model"
  | "route"
  | "source"
  | "totalTokens"
  | "inputTokens"
  | "outputTokens"
  | "reasoningTokens"
  | "cachedTokens"
  | "cost"
  | "isError";
type SortOrder = "asc" | "desc";
export type SortKey = { field: SortField; order: SortOrder };

// 注意：必须使用 sql.raw() 来引用外部表字段，否则 Drizzle 会丢失表名前缀
// 反斜杠需要双重转义：JS 字符串转义 + PostgreSQL E'' 字符串转义
const COST_EXPR = sql<number>`coalesce(
  -- 尝试精确匹配
  (select (
    (greatest(${sql.raw('"usage_records"."input_tokens"')} - ${sql.raw('"usage_records"."cached_tokens"')}, 0)::numeric / 1000000) * mp.input_price_per_1m
    + (${sql.raw('"usage_records"."cached_tokens"')}::numeric / 1000000) * mp.cached_input_price_per_1m
    + ((${sql.raw('"usage_records"."output_tokens"')} + ${sql.raw('"usage_records"."reasoning_tokens"')})::numeric / 1000000) * mp.output_price_per_1m
  )
  from model_prices mp
  where mp.model = ${sql.raw('"usage_records"."model"')}
  limit 1),
  -- 如果精确匹配失败，尝试通配符匹配（按非通配符字符数量降序选择最具体的）
  (select (
    (greatest(${sql.raw('"usage_records"."input_tokens"')} - ${sql.raw('"usage_records"."cached_tokens"')}, 0)::numeric / 1000000) * mp.input_price_per_1m
    + (${sql.raw('"usage_records"."cached_tokens"')}::numeric / 1000000) * mp.cached_input_price_per_1m
    + ((${sql.raw('"usage_records"."output_tokens"')} + ${sql.raw('"usage_records"."reasoning_tokens"')})::numeric / 1000000) * mp.output_price_per_1m
  )
  from model_prices mp
  where mp.model like '%*%'
    and ${sql.raw('"usage_records"."model"')} ~ (
      '^' ||
      regexp_replace(
        regexp_replace(
          mp.model,
          E'([.+?^$()\\\\[\\\\]{}|\\\\\\\\-])',
          E'\\\\\\\\\\\\1',
          'g'
        ),
        E'\\\\*',
        '.*',
        'g'
      )
      || '$'
    )
  order by length(replace(mp.model, '*', '')) desc, length(mp.model) desc
  limit 1),
  -- 如果都没匹配，返回 0
  0
)`;

const CREDENTIAL_NAME_EXPR = sql<string>`coalesce(
  nullif(${usageRecords.email}, ''),
  '未知渠道'
)`;

const PROVIDER_EXPR = sql<string>`coalesce(
  nullif(${usageRecords.provider}, ''),
  '未知渠道'
)`;

function getSortExpr(sortField: SortField): any {
  switch (sortField) {
    case "model": return usageRecords.model;
    case "route": return usageRecords.route;
    case "source": return CREDENTIAL_NAME_EXPR;
    case "totalTokens": return usageRecords.totalTokens;
    case "inputTokens": return usageRecords.inputTokens;
    case "outputTokens": return usageRecords.outputTokens;
    case "reasoningTokens": return usageRecords.reasoningTokens;
    case "cachedTokens": return usageRecords.cachedTokens;
    case "cost": return COST_EXPR;
    case "isError": return usageRecords.isError;
    case "occurredAt":
    default: return usageRecords.occurredAt;
  }
}

function parseCursor(input: string | null): UsageRecordCursor | null {
  if (!input) return null;
  try {
    const raw = Buffer.from(input, "base64").toString("utf8");
    const parsed = JSON.parse(raw) as UsageRecordCursor;
    if (parsed && typeof parsed.lastId === "number") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function buildCursorWhere(
  primaryKey: SortKey,
  cursor: UsageRecordCursor | null,
  sortExpr: any
): any {
  if (!cursor) return undefined;

  const { field: sortField, order: sortOrder } = primaryKey;
  const { lastValue, lastId } = cursor;

  if (sortField === "occurredAt") {
    const lastDate = new Date(String(lastValue));
    if (!Number.isFinite(lastDate.getTime())) return undefined;
    return sortOrder === "asc"
      ? sql`(${usageRecords.occurredAt} > ${lastDate} OR (${usageRecords.occurredAt} = ${lastDate} AND ${usageRecords.id} > ${lastId}))`
      : sql`(${usageRecords.occurredAt} < ${lastDate} OR (${usageRecords.occurredAt} = ${lastDate} AND ${usageRecords.id} < ${lastId}))`;
  }

  return sortOrder === "asc"
    ? sql`(${sortExpr} > ${lastValue} OR (${sortExpr} = ${lastValue} AND ${usageRecords.id} > ${lastId}))`
    : sql`(${sortExpr} < ${lastValue} OR (${sortExpr} = ${lastValue} AND ${usageRecords.id} < ${lastId}))`;
}

export async function getUsageRecords(input: {
  limit?: number;
  sortKeys?: SortKey[];
  sortField?: SortField;
  sortOrder?: SortOrder;
  cursor?: string | null;
  project?: string | null;
  model?: string | null;
  route?: string | null;
  source?: string | null;
  start?: string | null;
  end?: string | null;
  includeFilters?: boolean;
}) {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const rawSortKeys: SortKey[] =
    input.sortKeys && input.sortKeys.length > 0
      ? input.sortKeys
      : [{ field: input.sortField ?? "occurredAt", order: input.sortOrder ?? "desc" }];
  const seenFields = new Set<SortField>();
  const sortKeys: SortKey[] = rawSortKeys.filter(k => {
    if (seenFields.has(k.field)) return false;
    seenFields.add(k.field);
    return true;
  });
  const primaryKey = sortKeys[0];
  const primaryField = primaryKey.field;
  const primaryOrder = primaryKey.order;
  const cursor = parseCursor(input.cursor ?? null);

  const whereParts: any[] = [];

  if (input.start) {
    const startDate = new Date(input.start);
    if (Number.isFinite(startDate.getTime())) {
      whereParts.push(gte(usageRecords.occurredAt, startDate));
    }
  }

  if (input.end) {
    const endDate = new Date(input.end);
    if (Number.isFinite(endDate.getTime())) {
      whereParts.push(lte(usageRecords.occurredAt, endDate));
    }
  }

  if (input.project && input.project !== "all") {
    whereParts.push(eq(usageRecords.project, input.project));
  }

  if (input.model) {
    whereParts.push(eq(usageRecords.model, input.model));
  }

  if (input.route) {
    whereParts.push(eq(usageRecords.route, input.route));
  }

  if (input.source) {
    whereParts.push(sql`${CREDENTIAL_NAME_EXPR} = ${input.source}`);
  }

  const primarySortExpr = getSortExpr(primaryField) as any;
  const baseWhere = whereParts.length ? and(...whereParts) : undefined;

  const baseWhere = whereParts.length ? and(...whereParts) : undefined;
  const cursorWhere = buildCursorWhere(primaryKey, cursor, primarySortExpr);
  if (cursorWhere) whereParts.push(cursorWhere);
  const where = whereParts.length ? and(...whereParts) : undefined;

  const shouldComputeCostInSql = primaryField === "cost";
  const selectedCostExpr = shouldComputeCostInSql ? COST_EXPR : sql<number>`0`;

  const query = db
    .select({
      id: usageRecords.id,
      occurredAt: usageRecords.occurredAt,
      route: usageRecords.route,
      source: usageRecords.email,
      credentialName: CREDENTIAL_NAME_EXPR,
      provider: PROVIDER_EXPR,
      model: usageRecords.model,
      totalTokens: usageRecords.totalTokens,
      inputTokens: usageRecords.inputTokens,
      outputTokens: usageRecords.outputTokens,
      reasoningTokens: usageRecords.reasoningTokens,
      cachedTokens: usageRecords.cachedTokens,
      isError: usageRecords.isError,
      cost: selectedCostExpr
    })
    .from(usageRecords)
    .where(where)
    .orderBy(
      ...sortKeys.map(k => {
        const expr = getSortExpr(k.field) as any;
        return k.order === "asc" ? asc(expr) : desc(expr);
      }),
      primaryOrder === "asc" ? asc(usageRecords.id) : desc(usageRecords.id)
    )
    .limit(limit + 1);

  const rows: UsageRecordRow[] = await query;

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  let priceLookup: ReturnType<typeof priceMap> | null = null;
  if (!shouldComputeCostInSql) {
    const priceRows = await db.select().from(modelPrices);
    priceLookup = priceMap(
      priceRows.map((p) => ({
        model: p.model,
        inputPricePer1M: Number(p.inputPricePer1M),
        cachedInputPricePer1M: Number(p.cachedInputPricePer1M),
        outputPricePer1M: Number(p.outputPricePer1M)
      }))
    );
  }

  const nextCursor = (() => {
    if (!hasMore) return null;
    const last = items[items.length - 1];
    if (!last) return null;
    const lastValue = (() => {
      switch (primaryField) {
        case "model":
          return last.model;
        case "totalTokens":
          return last.totalTokens;
        case "cost":
          return Number(last.cost ?? 0);
        case "route":
          return last.route;
        case "source":
          return last.credentialName;
        case "inputTokens":
          return last.inputTokens;
        case "outputTokens":
          return last.outputTokens;
        case "reasoningTokens":
          return last.reasoningTokens;
        case "cachedTokens":
          return last.cachedTokens;
        case "isError":
          return last.isError ? 1 : 0;
        case "occurredAt":
        default:
          return last.occurredAt.toISOString();
      }
    })();
    const cursorPayload: UsageRecordCursor = { lastValue, lastId: last.id };
    return Buffer.from(JSON.stringify(cursorPayload)).toString("base64");
  })();

  let filters: { models: string[]; routes: string[]; sources: string[] } | undefined;
  if (input.includeFilters) {
    const [modelRows, routeRows, sourceRows]: [
      Array<{ model: string }>,
      Array<{ route: string }>,
      Array<{ source: string }>
    ] = await Promise.all([
      db
        .select({ model: usageRecords.model })
        .from(usageRecords)
        .where(baseWhere)
        .groupBy(usageRecords.model)
        .orderBy(usageRecords.model)
        .limit(200),
      db
        .select({ route: usageRecords.route })
        .from(usageRecords)
        .where(baseWhere)
        .groupBy(usageRecords.route)
        .orderBy(usageRecords.route)
        .limit(200),
      db
        .select({ source: CREDENTIAL_NAME_EXPR })
        .from(usageRecords)
        .where(where)
        .groupBy(CREDENTIAL_NAME_EXPR)
        .orderBy(CREDENTIAL_NAME_EXPR)
        .limit(200),
    ]);
    filters = {
      models: modelRows.map((row) => row.model),
      routes: routeRows.map((row) => row.route),
      sources: sourceRows.map((row) => row.source).filter((name): name is string => Boolean(name) && name !== "未知渠道")
    };
  }

  return {
    items: items.map((row) => ({
      ...row,
      cost: shouldComputeCostInSql
        ? Number(row.cost ?? 0)
        : estimateCost(
            {
              inputTokens: row.inputTokens,
              cachedTokens: row.cachedTokens,
              outputTokens: row.outputTokens,
              reasoningTokens: row.reasoningTokens
            },
            row.model,
            priceLookup ?? { exact: {}, patterns: [] }
          )
    })),
    nextCursor,
    filters
  };
}