import { NextResponse } from "next/server";
import { z } from "zod";
import { config } from "@/lib/config";
import { db } from "@/lib/db/client";
import { modelPrices } from "@/lib/db/schema";

type ModelPriceRow = typeof modelPrices.$inferSelect;

const priceSchema = z.object({
  model: z.string().min(1),
  inputPricePer1M: z.number().nonnegative(),
  cachedInputPricePer1M: z.number().nonnegative().optional().default(0),
  outputPricePer1M: z.number().nonnegative()
});

export const runtime = "nodejs";

let pricesCache: { value: Array<{ model: string; inputPricePer1M: number; cachedInputPricePer1M: number; outputPricePer1M: number }>; updatedAt: number } | null = null;

function ensureDbEnv() {
  if (!config.postgresUrl) {
    throw new Error("DATABASE_URL is missing");
  }
}

export async function GET() {
  try {
    ensureDbEnv();
    const rows = await db.select().from(modelPrices).orderBy(modelPrices.model);
    const normalized = rows.map((row: ModelPriceRow) => ({
      model: row.model,
      inputPricePer1M: Number(row.inputPricePer1M),
      cachedInputPricePer1M: Number(row.cachedInputPricePer1M),
      outputPricePer1M: Number(row.outputPricePer1M)
    }));
    pricesCache = { value: normalized, updatedAt: Date.now() };
    return NextResponse.json(normalized, { status: 200 });
  } catch (error) {
    console.error("/api/prices GET failed:", error);
    if (pricesCache) {
      return NextResponse.json(pricesCache.value, { status: 200 });
    }
    return NextResponse.json([], { status: 200 });
  }
}

export async function POST(request: Request) {
  try {
    ensureDbEnv();
    const body = await request.json();
    const parsed = priceSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
    }

    const data = parsed.data;
    await db
      .insert(modelPrices)
      .values({
        model: data.model,
        inputPricePer1M: String(data.inputPricePer1M),
        cachedInputPricePer1M: String(data.cachedInputPricePer1M ?? 0),
        outputPricePer1M: String(data.outputPricePer1M)
      })
      .onConflictDoUpdate({
        target: modelPrices.model,
        set: {
          inputPricePer1M: String(data.inputPricePer1M),
          cachedInputPricePer1M: String(data.cachedInputPricePer1M ?? 0),
          outputPricePer1M: String(data.outputPricePer1M)
        }
      });

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error("/api/prices POST failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

import * as DrizzleOrm from "drizzle-orm";
const { eq } = DrizzleOrm as any;

const deleteSchema = z.object({
  model: z.string().min(1)
});

export async function DELETE(request: Request) {
  try {
    ensureDbEnv();
    const body = await request.json();
    const parsed = deleteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
    }

    await db.delete(modelPrices).where(eq(modelPrices.model, parsed.data.model));
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error("/api/prices DELETE failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
