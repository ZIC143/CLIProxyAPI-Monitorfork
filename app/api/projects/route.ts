import { NextResponse } from "next/server";
import { asc, sql } from "drizzle-orm";
import { config } from "@/lib/config";
import { db } from "@/lib/db/client";
import { usageRecords } from "@/lib/db/schema";

export const runtime = "nodejs";
export const revalidate = 300;

export async function GET() {
  const configuredProjects = config.cliproxyProjects.map((project, index) => ({
    id: project.id,
    label: project.isPrimary ? "主项目" : `项目 ${index + 1}`,
    isPrimary: project.isPrimary
  }));

  const configuredMap = new Map(configuredProjects.map((project) => [project.id, project]));
  const dbProjects = await db
    .select({ project: usageRecords.project })
    .from(usageRecords)
    .groupBy(usageRecords.project)
    .orderBy(asc(usageRecords.project));

  const historicalProjects = dbProjects
    .map((row) => String(row.project || "").trim())
    .filter(Boolean)
    .filter((projectId) => !configuredMap.has(projectId))
    .map((projectId, index) => ({
      id: projectId,
      label: `历史项目 ${index + 1}`,
      isPrimary: false
    }));

  const projects = [...configuredProjects, ...historicalProjects];

  return NextResponse.json({ projects });
}
