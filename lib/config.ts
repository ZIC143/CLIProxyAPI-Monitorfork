import { createHash } from "node:crypto";

type CliproxyProject = {
  id: string;
  rootUrl: string;
  baseUrl: string;
  managementUrl: string;
  apiKey: string;
  isPrimary: boolean;
};

function normalizeProjectRoot(raw: string | undefined) {
  const value = (raw || "").trim();
  if (!value) return "";
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return withProtocol
    .replace(/\/v0\/management\/?$/i, "")
    .replace(/\/$/, "");
}

function toManagementApiBase(rootUrl: string) {
  return `${rootUrl}/v0/management`;
}

function toManagementPageUrl(rootUrl: string) {
  return `${rootUrl}/management.html`;
}

function parseCsvEnv(raw: string | undefined) {
  return (raw || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function buildProjectId(rootUrl: string) {
  return createHash("sha256").update(rootUrl).digest("hex").slice(0, 12);
}

function buildCliproxyProjects(): CliproxyProject[] {
  const listBases = parseCsvEnv(process.env.CLIPROXY_API_BASE_URLS);
  const listKeys = parseCsvEnv(process.env.CLIPROXY_SECRET_KEYS);

  const singleBase = (process.env.CLIPROXY_API_BASE_URL || "").trim();
  const singleKey = (process.env.CLIPROXY_SECRET_KEY || "").trim();

  const baseCandidates = listBases.length > 0 ? listBases : singleBase ? [singleBase] : [];
  const fallbackKey = singleKey || listKeys[0] || "";

  const projects: CliproxyProject[] = [];
  const seenIds = new Set<string>();

  for (let index = 0; index < baseCandidates.length; index += 1) {
    const rootUrl = normalizeProjectRoot(baseCandidates[index]);
    if (!rootUrl) continue;

    const apiKey = (listKeys[index] || fallbackKey || "").trim();
    if (!apiKey) continue;

    const id = buildProjectId(rootUrl);
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    projects.push({
      id,
      rootUrl,
      baseUrl: toManagementApiBase(rootUrl),
      managementUrl: toManagementPageUrl(rootUrl),
      apiKey,
      isPrimary: index === 0
    });
  }

  return projects;
}

const cliproxyProjects = buildCliproxyProjects();
const primaryProject = cliproxyProjects[0] ?? null;
const password = process.env.PASSWORD || process.env.CLIPROXY_SECRET_KEY || "";
const cronSecret = process.env.CRON_SECRET || "";

function normalizeTimezone(raw: string | undefined): string {
  const value = (raw || "").trim();
  if (!value) return "Asia/Shanghai";
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return value;
  } catch {
    console.warn(`TIMEZONE env var "${value}" is not a valid IANA timezone. Falling back to Asia/Shanghai.`);
    return "Asia/Shanghai";
  }
}

const timezone = normalizeTimezone(process.env.TIMEZONE);

export const config = {
  cliproxyProjects,
  primaryProject,
  cliproxy: {
    baseUrl: primaryProject?.baseUrl || "",
    usageBaseUrl: primaryProject?.baseUrl || "",
    apiKey: primaryProject?.apiKey || ""
  },
  postgresUrl: process.env.DATABASE_URL || "",
  password,
  cronSecret,
  timezone
};

export function getProjectById(projectId?: string | null) {
  if (!projectId || projectId === "all") return null;
  return config.cliproxyProjects.find((project) => project.id === projectId) ?? null;
}

export function assertEnv() {
  if (config.cliproxyProjects.length === 0) {
    throw new Error("CLIPROXY_API_BASE_URL(S) or CLIPROXY_SECRET_KEY(S) is missing");
  }
  if (!config.cliproxy.usageBaseUrl) {
    throw new Error("USAGE_API_BASE_URL is missing");
  }
  if (!config.postgresUrl) {
    throw new Error("DATABASE_URL is missing");
  }
}
