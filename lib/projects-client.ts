export type ProjectOption = { id: string; label: string };

type CachedPayload = {
  expiresAt: number;
  value: ProjectOption[];
};

const CACHE_KEY = "project_options_cache_v1";
const CACHE_TTL_MS = 5 * 60 * 1000;
let inflight: Promise<ProjectOption[]> | null = null;

function readCache(): ProjectOption[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedPayload;
    if (!parsed?.expiresAt || !Array.isArray(parsed?.value)) return null;
    if (Date.now() >= parsed.expiresAt) {
      window.localStorage.removeItem(CACHE_KEY);
      return null;
    }
    return parsed.value;
  } catch {
    return null;
  }
}

function writeCache(value: ProjectOption[]) {
  if (typeof window === "undefined") return;
  try {
    const payload: CachedPayload = { expiresAt: Date.now() + CACHE_TTL_MS, value };
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    // ignore storage failures
  }
}

export async function fetchProjectOptions(forceRefresh = false): Promise<ProjectOption[]> {
  const cached = !forceRefresh ? readCache() : null;
  if (cached) return cached;

  if (inflight) return inflight;

  inflight = (async () => {
    const res = await fetch("/api/projects", { cache: "force-cache" });
    if (!res.ok) throw new Error("load projects failed");
    const data = await res.json();
    const list = Array.isArray(data?.projects) ? data.projects : [];
    const mapped: ProjectOption[] = list.map((p: any) => ({
      id: String(p.id),
      label: String(p.label || p.id)
    }));
    writeCache(mapped);
    return mapped;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
