import { NextResponse } from "next/server";
import { config } from "@/lib/config";

export const runtime = "nodejs";
export const revalidate = 300;

export async function GET() {
  const projects = config.cliproxyProjects.map((project, index) => ({
    id: project.id,
    label: index === 0 ? "主项目" : index === 1 ? "项目二" : `项目${index + 1}`
  }));

  return NextResponse.json({ projects });
}
