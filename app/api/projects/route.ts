import { NextResponse } from "next/server";
import { config } from "@/lib/config";

export const runtime = "nodejs";
export const revalidate = 300;

export async function GET() {
  const projects = config.cliproxyProjects.map((project, index) => ({
    id: project.id,
    label: project.isPrimary ? "主项目" : `项目 ${index + 1}`,
    isPrimary: project.isPrimary
  }));

  return NextResponse.json({ projects });
}
