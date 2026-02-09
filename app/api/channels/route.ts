import { NextResponse } from "next/server";
import { and, eq, sql, gte, lte } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { usageRecords, modelPrices } from "@/lib/db/schema";
import { estimateCost, priceMap } from "@/lib/usage";

type ChannelsPayload = { channels: Array<{ channel: string; requests: number; totalTokens: number; inputTokens: number; outputTokens: number; reasoningTokens: number; cachedTokens: number; errorCount: number; cost: number }>; days: number };

type CachedChannels = {
  expiresAt: number;
  value: ChannelsPayload;
};

const CHANNELS_CACHE_TTL_MS = 20_000;
const CHANNELS_CACHE_MAX_ENTRIES = 80;
const channelsCache = new Map<string, CachedChannels>();

function makeCacheKey(input: { start?: string | null; end?: string | null; days: number; project?: string | null }) {
  return JSON.stringify({
    start: input.start ?? null,
    end: input.end ?? null,
    days: input.days,
    project: input.project ?? null
  });
}

function getCached(key: string) {
  const hit = channelsCache.get(key);
  if (!hit) return null;
  if (Date.now() >= hit.expiresAt) {
    channelsCache.delete(key);
    return null;
  }
  return hit.value;
}

function setCached(key: string, value: ChannelsPayload) {
  if (channelsCache.size >= CHANNELS_CACHE_MAX_ENTRIES) {
    const oldestKey = channelsCache.keys().next().value as string | undefined;
    if (oldestKey) channelsCache.delete(oldestKey);
  }
  channelsCache.set(key, { expiresAt: Date.now() + CHANNELS_CACHE_TTL_MS, value });
}

type ChannelAggRow = {
  channel: string | null;
  requests: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  errorCount: number;
};

type ChannelModelAggRow = {
  channel: string | null;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
};

type PriceRow = typeof modelPrices.$inferSelect;

function toNumber(value: unknown): number {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? num : 0;
}

function parseDateInput(value?: string | Date | null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function withDayStart(date: Date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function withDayEnd(date: Date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const startParam = searchParams.get("start");
  const endParam = searchParams.get("end");
  const daysParam = searchParams.get("days");
  const project = searchParams.get("project");
  const skipCache = searchParams.get("skipCache") === "1";

  const startDate = parseDateInput(startParam);
  const endDate = parseDateInput(endParam);
  const hasCustomRange = startDate && endDate && endDate >= startDate;

  const DAY_MS = 24 * 60 * 60 * 1000;
  const days = hasCustomRange 
    ? Math.max(1, Math.round((withDayEnd(endDate).getTime() - withDayStart(startDate).getTime()) / DAY_MS) + 1)
    : Math.min(Math.max(Math.floor(Number(daysParam) || 14), 1), 90);

  const cacheKey = makeCacheKey({ start: startParam, end: endParam, days, project });
  if (!skipCache) {
    const cached = getCached(cacheKey);
    if (cached) return NextResponse.json(cached);
  }

  const since = hasCustomRange ? withDayStart(startDate!) : new Date(Date.now() - days * DAY_MS);
  const until = hasCustomRange ? withDayEnd(endDate!) : undefined;

  const whereParts: SQL[] = [gte(usageRecords.occurredAt, since)];
  if (until) whereParts.push(lte(usageRecords.occurredAt, until));
  if (project && project !== "all") whereParts.push(eq(usageRecords.project, project));
  const whereClause = whereParts.length ? and(...whereParts) : undefined;

  try {
    // Fetch aggregated channel statistics
    const channelAggRows: ChannelAggRow[] = await db
      .select({
        channel: usageRecords.source,
        requests: sql<number>`count(*)`,
        tokens: sql<number>`sum(${usageRecords.totalTokens})`,
        inputTokens: sql<number>`sum(${usageRecords.inputTokens})`,
        outputTokens: sql<number>`sum(${usageRecords.outputTokens})`,
        reasoningTokens: sql<number>`coalesce(sum(${usageRecords.reasoningTokens}), 0)`,
        cachedTokens: sql<number>`coalesce(sum(${usageRecords.cachedTokens}), 0)`,
        errorCount: sql<number>`sum(case when ${usageRecords.isError} then 1 else 0 end)`
      })
      .from(usageRecords)
      .where(whereClause)
      .groupBy(usageRecords.source)
      .orderBy(sql`count(*) desc`);

    // Fetch channel-model breakdown for cost calculation
    const channelModelAggRows: ChannelModelAggRow[] = await db
      .select({
        channel: usageRecords.source,
        model: usageRecords.model,
        requests: sql<number>`count(*)`,
        inputTokens: sql<number>`sum(${usageRecords.inputTokens})`,
        outputTokens: sql<number>`sum(${usageRecords.outputTokens})`,
        reasoningTokens: sql<number>`coalesce(sum(${usageRecords.reasoningTokens}), 0)`,
        cachedTokens: sql<number>`coalesce(sum(${usageRecords.cachedTokens}), 0)`
      })
      .from(usageRecords)
      .where(whereClause)
      .groupBy(usageRecords.source, usageRecords.model);

    // Fetch pricing information
    const priceRows: PriceRow[] = await db.select().from(modelPrices);
    const prices = priceMap(
      priceRows.map((p: PriceRow) => ({
        model: p.model,
        inputPricePer1M: Number(p.inputPricePer1M),
        cachedInputPricePer1M: Number(p.cachedInputPricePer1M),
        outputPricePer1M: Number(p.outputPricePer1M)
      }))
    );

    // Calculate costs per channel
    const channelCostMap = new Map<string, number>();
    for (const row of channelModelAggRows) {
      const channelKey = row.channel ?? "未知渠道";
      const cost = estimateCost(
        {
          inputTokens: toNumber(row.inputTokens),
          cachedTokens: toNumber(row.cachedTokens),
          outputTokens: toNumber(row.outputTokens),
          reasoningTokens: toNumber(row.reasoningTokens)
        },
        row.model,
        prices
      );
      channelCostMap.set(channelKey, (channelCostMap.get(channelKey) ?? 0) + cost);
    }

    // Build response
    const channels = channelAggRows.map((row) => {
      const channelKey = row.channel ?? "未知渠道";
      return {
        channel: channelKey,
        requests: toNumber(row.requests),
        totalTokens: toNumber(row.tokens),
        inputTokens: toNumber(row.inputTokens),
        outputTokens: toNumber(row.outputTokens),
        reasoningTokens: toNumber(row.reasoningTokens),
        cachedTokens: toNumber(row.cachedTokens),
        errorCount: toNumber(row.errorCount),
        cost: Number((channelCostMap.get(channelKey) ?? 0).toFixed(4))
      };
    });

    const payload = { channels, days };
    setCached(cacheKey, payload);
    return NextResponse.json(payload);
  } catch (error) {
    console.error("Error fetching channel statistics:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
