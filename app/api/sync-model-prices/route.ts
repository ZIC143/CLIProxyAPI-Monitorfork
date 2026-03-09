import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { inArray, desc, eq, and, gte } from "drizzle-orm";
import { config } from "@/lib/config";
import { db } from "@/lib/db/client";
import { modelPrices, usageRecords } from "@/lib/db/schema";

export const runtime = "nodejs";

const PASSWORD = process.env.PASSWORD || process.env.CLIPROXY_SECRET_KEY || "";
const COOKIE_NAME = "dashboard_auth";
const SYNC_LOCK_TTL_MS = 1 * 60 * 1000;

let syncInFlight = false;
let syncStartedAt = 0;
let modelsDevETag: string | null = null;
let modelsDevLastModified: string | null = null;
let modelsDevHash: string | null = null;
let modelsDevCache: ModelsDevResponse | null = null;

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

async function hashString(value: string) {
  const data = new TextEncoder().encode(value);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 统一价格精度到数据库列精度（numeric(10,4)），避免科学计数法/格式差异导致"假更新"
function normalizePriceForDb(value: unknown): string {
  const num = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(num)) return "0.0000";
  const nonNegative = Math.max(0, num);
  return nonNegative.toFixed(4);
}

type ModelsDevModel = {
  id: string;
  cost?: { input?: number; output?: number; cache_read?: number };
};

type ModelsDevProvider = {
  models: Record<string, ModelsDevModel>;
};

type ModelsDevResponse = Record<string, ModelsDevProvider>;
type PriceInfo = { input: number; output: number; cached: number };
type PriceModeCandidate = {
  count: number;
  firstSeenOrder: number;
  firstSeenProvider: string;
  providers: Set<string>;
  price: PriceInfo;
};
type PriceSelectionMeta = {
  modeCount: number;
  totalCount: number;
  tieCount: number;
  tieBreakApplied: boolean;
  firstSeenProvider: string;
  providers: string[];
  signature: string;
};

type UsedModelRow = { model: string };

async function getUsedModels(project?: string, days = 90): Promise<string[]> {
  const since = new Date(Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000);
  const whereParts = [gte(usageRecords.occurredAt, since)];
  if (project && project !== "all") {
    whereParts.push(eq(usageRecords.project, project));
  }

  const rows: UsedModelRow[] = await db
    .select({ model: usageRecords.model })
    .from(usageRecords)
    .where(and(...whereParts))
    .groupBy(usageRecords.model)
    .orderBy(usageRecords.model);

  return rows.map((r) => r.model).filter(Boolean);
}

export async function POST(request: Request) {
  try {
    // 🔒 鉴权检查
    if (!(await isAuthorized(request))) {
      return unauthorized();
    }

    // 并发锁：避免重复同步
    const now = Date.now();
    if (syncInFlight && now - syncStartedAt < SYNC_LOCK_TTL_MS) {
      return NextResponse.json({ error: "同步正在进行中，请稍后再试" }, { status: 429 });
    }
    syncInFlight = true;
    syncStartedAt = now;

    if (!config.cliproxy.baseUrl) {
      return NextResponse.json({ error: "服务端未配置 CLIPROXY_API_BASE_URL" }, { status: 500 });
    }

    if (!config.postgresUrl) {
      return NextResponse.json({ error: "服务端未配置 DATABASE_URL" }, { status: 500 });
    }

    const reqBody = await request
      .json()
      .catch(() => ({} as { project?: string | null; usedModels?: string[] }));
    const project = reqBody?.project ?? null;
    const inputUsedModels: string[] = Array.isArray(reqBody?.usedModels)
      ? Array.from(new Set<string>(reqBody.usedModels.map((m: unknown) => String(m || "").trim()).filter(Boolean)))
      : [];

    // 从数据库获取最新的 route 值作为 API Key
    const latestRecord = await db
      .select({ route: usageRecords.route })
      .from(usageRecords)
      .orderBy(desc(usageRecords.id))
      .limit(1);

    if (!latestRecord.length || !latestRecord[0].route) {
      return NextResponse.json({ error: "数据库中没有可用的 API Key 记录" }, { status: 500 });
    }

    const apiKey = latestRecord[0].route;

    // 1. 从 models.dev 获取价格数据
    const modelsDevHeaders: Record<string, string> = { "Accept": "application/json" };
    if (modelsDevETag) modelsDevHeaders["If-None-Match"] = modelsDevETag;
    if (modelsDevLastModified) modelsDevHeaders["If-Modified-Since"] = modelsDevLastModified;

    const modelsDevRes = await fetch("https://models.dev/api.json", {
      headers: modelsDevHeaders,
      cache: "no-store"
    });

    // 处理 304 Not Modified 响应
    if (modelsDevRes.status === 304) {
      if (!modelsDevCache) {
        return NextResponse.json({ error: "models.dev 返回未修改且无本地缓存" }, { status: 502 });
      }
      // 304 且有缓存，继续使用缓存数据
    } else if (!modelsDevRes.ok) {
      // 其他非 2xx 状态视为错误
      return NextResponse.json({ error: `无法获取 models.dev 数据: ${modelsDevRes.status}` }, { status: 502 });
    }

    const modelsDevData: ModelsDevResponse = modelsDevRes.status === 304
      ? modelsDevCache as ModelsDevResponse
      : await modelsDevRes.json();
    const etag = modelsDevRes.headers.get("etag");
    const lastModified = modelsDevRes.headers.get("last-modified");
    if (etag) modelsDevETag = etag;
    if (lastModified) modelsDevLastModified = lastModified;

    const currentHash = await hashString(JSON.stringify(modelsDevData));
    if (!modelsDevHash || modelsDevHash !== currentHash) {
      modelsDevHash = currentHash;
      modelsDevCache = modelsDevData;
    }

    // 2. 构建模型ID到价格的映射（同名用"众数"策略；并列众数取首次出现）
    const priceModeBuckets = new Map<string, Map<string, PriceModeCandidate>>();
    let seenOrder = 0;

    for (const [providerId, provider] of Object.entries(modelsDevData)) {
      if (!provider.models) continue;
      for (const model of Object.values(provider.models)) {
        // 允许免费模型入库
        if (model.cost && (model.cost.input !== undefined || model.cost.output !== undefined)) {
          const priceInfo: PriceInfo = {
            input: model.cost.input ?? 0,
            output: model.cost.output ?? 0,
            cached: model.cost.cache_read ?? 0
          };

          // 以数据库精度归一后作为"价格组合"签名，避免格式差异影响众数统计
          const signature = [
            normalizePriceForDb(priceInfo.input),
            normalizePriceForDb(priceInfo.cached),
            normalizePriceForDb(priceInfo.output)
          ].join("|");

          const modelBucket = priceModeBuckets.get(model.id) ?? new Map<string, PriceModeCandidate>();
          const existingCandidate = modelBucket.get(signature);

          if (existingCandidate) {
            existingCandidate.count += 1;
            existingCandidate.providers.add(providerId);
          } else {
            modelBucket.set(signature, {
              count: 1,
              firstSeenOrder: seenOrder,
              firstSeenProvider: providerId,
              providers: new Set([providerId]),
              price: priceInfo
            });
          }

          priceModeBuckets.set(model.id, modelBucket);
          seenOrder += 1;
        }
      }
    }

    const priceMap = new Map<string, PriceInfo>();
    const priceSelectionMetaMap = new Map<string, PriceSelectionMeta>();
    for (const [modelId, candidates] of priceModeBuckets.entries()) {
      let selected: PriceModeCandidate | null = null;
      let selectedSignature: string | null = null;
      let totalCount = 0;
      let maxCount = 0;
      let tieCount = 0;

      for (const [signature, candidate] of candidates.entries()) {
        totalCount += candidate.count;
        if (candidate.count > maxCount) {
          maxCount = candidate.count;
          tieCount = 1;
        } else if (candidate.count === maxCount) {
          tieCount += 1;
        }

        if (!selected) {
          selected = candidate;
          selectedSignature = signature;
          continue;
        }

        if (
          candidate.count > selected.count ||
          (candidate.count === selected.count && candidate.firstSeenOrder < selected.firstSeenOrder)
        ) {
          selected = candidate;
          selectedSignature = signature;
        }
      }

      if (selected) {
        priceMap.set(modelId, selected.price);
        priceSelectionMetaMap.set(modelId, {
          modeCount: selected.count,
          totalCount,
          tieCount,
          tieBreakApplied: tieCount > 1,
          firstSeenProvider: selected.firstSeenProvider,
          providers: Array.from(selected.providers).sort(),
          signature: selectedSignature ?? ""
        });
      }
    }

    const buildSelectionSummary = (meta: PriceSelectionMeta | undefined) => {
      if (!meta) return undefined;
      if (meta.tieBreakApplied) {
        return `命中 ${meta.modeCount}/${meta.totalCount}｜存在并列｜源 ${meta.firstSeenProvider}`;
      }
      return `命中 ${meta.modeCount}/${meta.totalCount}｜源 ${meta.firstSeenProvider}`;
    };

    const buildSelectionDebug = (meta: PriceSelectionMeta | undefined) => {
      if (!meta) return undefined;
      const providers = meta.providers.length > 0 ? meta.providers.join(",") : meta.firstSeenProvider;
      return `命中计数=${meta.modeCount}/${meta.totalCount}；并列候选=${meta.tieCount}${meta.tieBreakApplied ? "（按首次出现裁决）" : ""}；首来源=${meta.firstSeenProvider}；来源集=${providers}；签名=${meta.signature}`;
    };

    // 3. 获取已使用模型列表（来源：usageRecords 聚合）
    const usedModels = inputUsedModels.length > 0 ? inputUsedModels : await getUsedModels(project ?? undefined, 90);
    const models: { id: string }[] = usedModels.map((id) => ({ id }));

    // 4. 匹配并收集要更新的价格
    let skippedCount = 0;
    let failedCount = 0;
    const details: {
      model: string;
      status: string;
      matchedWith?: string;
      reason?: string;
      selectionSummary?: string;
      selectionDebug?: string;
    }[] = [];
    const priceUpdates: { model: string; priceInfo: PriceInfo; matchedKey: string }[] = [];

    for (const { id: modelId } of models) {
      let priceInfo = priceMap.get(modelId);
      let matchedKey = modelId;

      // 去掉最后一个 - 后的内容，进行最长匹配
      if (!priceInfo) {
        const lastDashIndex = modelId.lastIndexOf("-");
        if (lastDashIndex > 0) {
          const baseNameWithoutSuffix = modelId.substring(0, lastDashIndex);
          let bestMatch: { key: string; value: PriceInfo; matchLength: number } | null = null;

          for (const [key, value] of priceMap.entries()) {
            if (key.startsWith(baseNameWithoutSuffix) || baseNameWithoutSuffix.startsWith(key)) {
              const matchLength = Math.min(key.length, baseNameWithoutSuffix.length);
              if (!bestMatch || matchLength > bestMatch.matchLength) {
                bestMatch = { key, value, matchLength };
              }
            }
          }

          if (bestMatch) {
            priceInfo = bestMatch.value;
            matchedKey = bestMatch.key;
          }
        }
      }

      // 尝试去掉前缀匹配
      if (!priceInfo) {
        const simpleName = modelId.split("/").pop() || modelId;
        priceInfo = priceMap.get(simpleName);
        if (priceInfo) matchedKey = simpleName;
      }

      // 模糊匹配
      if (!priceInfo) {
        const baseModelName = modelId.replace(/-\d{4,}.*$/, "").replace(/@.*$/, "");
        let bestMatch: { key: string; value: PriceInfo; matchLength: number } | null = null;

        for (const [key, value] of priceMap.entries()) {
          if (key.includes(baseModelName)) {
            const matchLength = baseModelName.length;
            if (!bestMatch || matchLength > bestMatch.matchLength) {
              bestMatch = { key, value, matchLength };
            }
          } else if (baseModelName.includes(key)) {
            const matchLength = key.length;
            if (!bestMatch || matchLength > bestMatch.matchLength) {
              bestMatch = { key, value, matchLength };
            }
          }
        }

        if (bestMatch) {
          priceInfo = bestMatch.value;
          matchedKey = bestMatch.key;
        }
      }

      if (!priceInfo) {
        skippedCount++;
        failedCount++;
        details.push({ model: modelId, status: "failed", reason: "未找到价格信息（已使用模型）" });
        continue;
      }

      const selectionSummary = buildSelectionSummary(priceSelectionMetaMap.get(matchedKey));
      const selectionDebug = buildSelectionDebug(priceSelectionMetaMap.get(matchedKey));
      priceUpdates.push({ model: modelId, priceInfo, matchedKey });
      details.push({ model: modelId, status: "pending", matchedWith: matchedKey, selectionSummary, selectionDebug });
    }

    // 5. 查询已保存价格（已保存不覆盖）
    const modelIds = priceUpdates.map((u) => u.model);
    const existingRows: Array<{
      model: string;
      input: unknown;
      cached: unknown;
      output: unknown;
    }> = modelIds.length
      ? await db
          .select({
            model: modelPrices.model,
            input: modelPrices.inputPricePer1M,
            cached: modelPrices.cachedInputPricePer1M,
            output: modelPrices.outputPricePer1M
          })
          .from(modelPrices)
          .where(inArray(modelPrices.model, modelIds))
      : [];

    const existingMap = new Map(
      existingRows.map((row) => [
        row.model,
        {
          input: normalizePriceForDb(row.input),
          cached: normalizePriceForDb(row.cached),
          output: normalizePriceForDb(row.output)
        }
      ])
    );

    // 6. 批量写入数据库（仅新增，已保存的不覆盖）
    let updatedCount = 0;
    for (const { model: modelId, priceInfo } of priceUpdates) {
      const nextInput = normalizePriceForDb(priceInfo.input);
      const nextCached = normalizePriceForDb(priceInfo.cached);
      const nextOutput = normalizePriceForDb(priceInfo.output);
      const existing = existingMap.get(modelId);

      if (existing) {
        skippedCount++;
        const detailIndex = details.findIndex((d) => d.model === modelId);
        if (detailIndex !== -1) {
          const prev = details[detailIndex];
          const composedReason = prev.selectionSummary ? `未变化（${prev.selectionSummary}）` : "未变化";
          details[detailIndex] = {
            model: modelId,
            status: "skipped",
            reason: composedReason,
            matchedWith: prev.matchedWith,
            selectionSummary: prev.selectionSummary,
            selectionDebug: prev.selectionDebug
          };
        }
        continue;
      }

      try {
        await db.insert(modelPrices).values({
          model: modelId,
          inputPricePer1M: nextInput,
          cachedInputPricePer1M: nextCached,
          outputPricePer1M: nextOutput
        });
        updatedCount++;
        const detailIndex = details.findIndex((d) => d.model === modelId);
        if (detailIndex !== -1) {
          const prev = details[detailIndex];
          const composedReason = prev.selectionSummary ? `已更新（${prev.selectionSummary}）` : "已更新";
          details[detailIndex] = {
            model: modelId,
            status: "updated",
            matchedWith: prev.matchedWith,
            reason: composedReason,
            selectionSummary: prev.selectionSummary,
            selectionDebug: prev.selectionDebug
          };
        }
      } catch (err) {
        failedCount++;
        const detailIndex = details.findIndex((d) => d.model === modelId);
        if (detailIndex !== -1) {
          const prev = details[detailIndex];
          const dbError = err instanceof Error ? err.message : "数据库写入失败";
          const composedReason = prev.selectionSummary ? `写库失败：${dbError}（${prev.selectionSummary}）` : `写库失败：${dbError}`;
          details[detailIndex] = {
            model: modelId,
            status: "failed",
            reason: composedReason,
            matchedWith: prev.matchedWith,
            selectionSummary: prev.selectionSummary,
            selectionDebug: prev.selectionDebug
          };
        }
      }
    }

    return NextResponse.json({
      success: true,
      summary: { total: models.length, updated: updatedCount, skipped: skippedCount, failed: failedCount },
      details
    });

  } catch (error) {
    console.error("/api/sync-model-prices POST failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "内部服务器错误" }, { status: 500 });
  } finally {
    syncInFlight = false;
  }
}
