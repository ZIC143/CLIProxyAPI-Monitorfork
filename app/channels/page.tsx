"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { formatCompactNumber, formatCurrency, formatNumberWithCommas } from "@/lib/utils";
import { Activity, RefreshCw, ChevronDown, ChevronRight, Key, Users, ArrowDown, ArrowUp, CalendarRange } from "lucide-react";
import { fetchProjectOptions } from "@/lib/projects-client";
import { DayPicker, type DateRange } from "react-day-picker";
import "react-day-picker/dist/style.css";
import { enUS, ja, ko, zhCN } from "date-fns/locale";

type ChannelStat = {
  channel: string;
  requests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  errorCount: number;
  cost: number;
};

type ChannelAPIResponse = {
  channels: ChannelStat[];
  days: number;
};

type ChannelGroup = {
  name: string;
  type: "auth" | "apikey";
  channels: ChannelStat[];
  total: Omit<ChannelStat, "channel">;
};

function aggregateStats(channels: ChannelStat[]): Omit<ChannelStat, "channel"> {
  return channels.reduce(
    (acc, ch) => ({
      requests: acc.requests + ch.requests,
      totalTokens: acc.totalTokens + ch.totalTokens,
      inputTokens: acc.inputTokens + ch.inputTokens,
      outputTokens: acc.outputTokens + ch.outputTokens,
      reasoningTokens: acc.reasoningTokens + ch.reasoningTokens,
      cachedTokens: acc.cachedTokens + ch.cachedTokens,
      errorCount: acc.errorCount + ch.errorCount,
      cost: acc.cost + ch.cost
    }),
    { requests: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, errorCount: 0, cost: 0 }
  );
}

function groupChannels(channels: ChannelStat[]): ChannelGroup[] {
  const authGroups = new Map<string, ChannelStat[]>();
  const apiKeyChannels: ChannelStat[] = [];

  for (const ch of channels) {
    const name = ch.channel;
    const slashIdx = name.indexOf("/");
    const looksLikeUrl = name.startsWith("http://") || name.startsWith("https://");
    const looksLikeHex = /^[0-9a-f]{8,}$/i.test(name);

    if (slashIdx > 0 && !looksLikeUrl && !looksLikeHex) {
      const provider = name.slice(0, slashIdx);
      const existing = authGroups.get(provider) || [];
      existing.push(ch);
      authGroups.set(provider, existing);
    } else {
      apiKeyChannels.push(ch);
    }
  }

  const groups: ChannelGroup[] = [];

  const authEntries = [...authGroups.entries()]
    .map(([name, chs]) => ({ name, channels: chs, total: aggregateStats(chs) }))
    .sort((a, b) => b.total.requests - a.total.requests);

  for (const entry of authEntries) {
    groups.push({ name: entry.name, type: "auth", channels: entry.channels, total: entry.total });
  }

  for (const ch of apiKeyChannels) {
    groups.push({
      name: ch.channel,
      type: "apikey",
      channels: [ch],
      total: { requests: ch.requests, totalTokens: ch.totalTokens, inputTokens: ch.inputTokens, outputTokens: ch.outputTokens, reasoningTokens: ch.reasoningTokens, cachedTokens: ch.cachedTokens, errorCount: ch.errorCount, cost: ch.cost }
    });
  }

  return groups;
}

function fmtRate(requests: number, errorCount: number): string {
  if (requests === 0) return "-";
  const rate = ((requests - errorCount) / requests) * 100;
  if (rate === 100) return "100%";
  return rate.toFixed(1) + "%";
}

function successRate(requests: number, errorCount: number): number {
  if (requests === 0) return 0;
  const ok = Math.max(0, requests - errorCount);
  return ok / requests;
}

function sortByMetric(a: Omit<ChannelStat, "channel">, b: Omit<ChannelStat, "channel">, sortBy: "requests" | "totalTokens" | "cost" | "successRate") {
  if (sortBy === "successRate") {
    return successRate(b.requests, b.errorCount) - successRate(a.requests, a.errorCount);
  }
  return b[sortBy] - a[sortBy];
}

function rateColor(requests: number, errorCount: number): string {
  if (requests === 0) return "text-slate-500";
  const rate = ((requests - errorCount) / requests) * 100;
  if (rate >= 99) return "text-emerald-400";
  if (rate >= 95) return "text-amber-400";
  return "text-red-400";
}

function TokenBar({ input, output, reasoning, cached, total }: { input: number; output: number; reasoning: number; cached: number; total: number }) {
  if (total === 0) return null;
  const segments = [
    { value: input - cached, color: "bg-rose-400", label: "输入" },
    { value: cached, color: "bg-purple-400", label: "缓存" },
    { value: output, color: "bg-emerald-400", label: "输出" },
    { value: reasoning, color: "bg-amber-400", label: "思考" },
  ].filter(s => s.value > 0);

  return (
    <div className="mt-1.5 mx-5 flex h-1.5 overflow-hidden rounded-full bg-slate-700/50">
      {segments.map((seg, i) => (
        <div
          key={i}
          className={`${seg.color} transition-all duration-300`}
          style={{ width: `${(seg.value / total) * 100}%` }}
          title={`${seg.label}: ${formatNumberWithCommas(seg.value)}`}
        />
      ))}
    </div>
  );
}

function TokenLegend() {
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
      <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full bg-rose-400" />输入</span>
      <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full bg-purple-400" />缓存</span>
      <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />输出</span>
      <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full bg-amber-400" />思考</span>
    </div>
  );
}

function formatDateInput(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDateTimeDisplay(value: string) {
  if (!value) return value;
  return value.replace("T", " ");
}

function parseDateTimeInput(value: string) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const time = value.includes("T") ? value.split("T")[1] ?? "00:00" : "00:00";
  return { date, time };
}

function diffDaysInclusive(start: Date, end: Date) {
  const dayMs = 24 * 60 * 60 * 1000;
  const s = new Date(start);
  const e = new Date(end);
  s.setHours(0, 0, 0, 0);
  e.setHours(0, 0, 0, 0);
  const diff = Math.round((e.getTime() - s.getTime()) / dayMs) + 1;
  return Math.max(1, diff);
}

/* Fixed column widths for alignment across all rows */
const COL = {
  arrow: "w-5 shrink-0",
  icon: "w-9 shrink-0",
  requests: "w-[72px] text-right shrink-0",
  tokens: "w-[90px] text-right shrink-0",
  cost: "w-[80px] text-right shrink-0",
  rate: "w-[56px] text-right shrink-0",
};

export default function ChannelsPage() {
  const [channels, setChannels] = useState<ChannelStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(14);
  const [startInput, setStartInput] = useState("");
  const [endInput, setEndInput] = useState("");
  const [rangePickerOpen, setRangePickerOpen] = useState(false);
  const [range, setRange] = useState<DateRange | undefined>(undefined);
  const [timeStart, setTimeStart] = useState("00:00");
  const [timeEnd, setTimeEnd] = useState("23:59");
  const [rangeError, setRangeError] = useState<string | null>(null);
  const rangePickerRef = useRef<HTMLDivElement | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<"requests" | "totalTokens" | "cost" | "successRate" | null>("requests");
  const [sortOrder, setSortOrder] = useState<"desc" | "asc" | null>("desc");
  const [project, setProject] = useState<string>("all");
  const [projectOptions, setProjectOptions] = useState<Array<{ id: string; label: string }>>([]);

  const fetchChannels = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("days", String(days));
      if (startInput && endInput) {
        params.set("start", new Date(startInput).toISOString());
        params.set("end", new Date(endInput).toISOString());
      }
      if (project !== "all") params.set("project", project);
      const response = await fetch(`/api/channels?${params.toString()}`);
      if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);
      const data: ChannelAPIResponse = await response.json();
      setChannels(data.channels || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [days, project, startInput, endInput]);

  const syncAndRefresh = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch("/api/sync", { method: "POST", cache: "no-store" });
      if (!res.ok) throw new Error(`同步失败: ${res.statusText}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "同步失败");
    } finally {
      setSyncing(false);
    }
    await fetchChannels();
  }, [fetchChannels]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const savedProject = window.localStorage.getItem("projectSelection");
    if (savedProject) setProject(savedProject);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("projectSelection", project);
  }, [project]);

  useEffect(() => {
    let active = true;
    const loadProjects = async () => {
      try {
        const list = await fetchProjectOptions();
        if (!active) return;
        setProjectOptions(list);
      } catch {
        if (active) setProjectOptions([]);
      }
    };
    loadProjects();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    fetchChannels();
  }, [fetchChannels]);

  const rangeLabel = useMemo(() => {
    if (!startInput && !endInput) return "选择时间范围";
    const startLabel = startInput ? formatDateTimeDisplay(startInput) : "-";
    const endLabel = endInput ? formatDateTimeDisplay(endInput) : "-";
    return `${startLabel} ~ ${endLabel}`;
  }, [startInput, endInput]);

  const dayPickerLocale = useMemo(() => {
    if (typeof navigator === "undefined") return zhCN;
    const lang = navigator.language.toLowerCase();
    if (lang.startsWith("zh")) return zhCN;
    if (lang.startsWith("ja")) return ja;
    if (lang.startsWith("ko")) return ko;
    return enUS;
  }, []);

  const dayPickerClassNames = useMemo(
    () => ({
      months: "flex flex-col gap-2",
      month: "space-y-2",
      caption: "flex items-center justify-between px-2 py-2 text-sm text-slate-200",
      caption_label: "text-sm font-semibold text-slate-100",
      nav: "flex items-center gap-2",
      nav_button: "h-7 w-7 rounded-md text-slate-300 hover:bg-slate-800/80",
      nav_button_previous: "hover:bg-slate-800/80",
      nav_button_next: "hover:bg-slate-800/80",
      table: "w-full border-separate border-spacing-y-2",
      head_row: "text-xs text-slate-500",
      head_cell: "pb-1",
      tbody: "",
      row: "w-full",
      cell: "p-0",
      day: "h-8 w-full text-sm text-slate-200 hover:!bg-indigo-500 hover:!text-white rounded-none hover:!rounded-md relative z-10 transition-all",
      day_today: "text-indigo-300 font-semibold",
      day_selected: "!bg-indigo-500 !text-white font-semibold rounded-none hover:!bg-indigo-600 hover:!text-white",
      day_range_start: "!bg-indigo-500 !text-white font-semibold !rounded-l-lg hover:!bg-indigo-600 hover:!text-white",
      day_range_end: "!bg-indigo-500 !text-white font-semibold !rounded-r-lg hover:!bg-indigo-600 hover:!text-white",
      day_range_middle: "!bg-indigo-500/25 !text-indigo-100 rounded-none hover:!bg-indigo-500/40 hover:!text-white hover:!rounded-none",
      day_outside: "text-slate-600",
      day_disabled: "text-slate-600"
    }),
    []
  );

  useEffect(() => {
    if (!rangePickerOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rangePickerRef.current && !rangePickerRef.current.contains(target)) {
        setRangePickerOpen(false);
        setRangeError(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [rangePickerOpen]);

  const toggleGroup = (name: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const handleSort = (key: "requests" | "totalTokens" | "cost" | "successRate") => {
    if (sortBy !== key) {
      setSortBy(key);
      setSortOrder("desc");
      return;
    }
    if (sortOrder === "desc") {
      setSortOrder("asc");
      return;
    }
    if (sortOrder === "asc") {
      setSortBy(null);
      setSortOrder(null);
      return;
    }
    setSortOrder("desc");
  };

  const groups = useMemo(() => {
    const g = groupChannels(channels);
    if (!sortBy || !sortOrder) return g;
    const orderFactor = sortOrder === "asc" ? -1 : 1;
    return g.sort((a, b) => orderFactor * sortByMetric(a.total, b.total, sortBy));
  }, [channels, sortBy, sortOrder]);

  const totalStats = useMemo(() => aggregateStats(channels), [channels]);
  const totalSuccessRate = useMemo(() => successRate(totalStats.requests, totalStats.errorCount), [totalStats]);
  const totalSuccessPct = useMemo(() => totalSuccessRate * 100, [totalSuccessRate]);
  const avgRequestsPerDay = useMemo(() => {
    if (days <= 0) return 0;
    return totalStats.requests / days;
  }, [totalStats.requests, days]);

  return (
    <main className="min-h-screen px-3 sm:px-6 py-6 sm:py-8 bg-slate-900 text-slate-100">
      {/* Header */}
      <header className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Activity className="h-6 w-6" />
            渠道统计
          </h1>
          <p className="text-base text-slate-400">按认证渠道查看用量和费用统计</p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={project}
            onChange={(event) => setProject(event.target.value)}
            className="w-28 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-200 hover:border-slate-500"
            title="选择项目"
          >
            <option value="all">全部项目</option>
            {projectOptions.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
          <button
            onClick={syncAndRefresh}
            disabled={syncing || loading}
            className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
              syncing || loading
                ? "cursor-not-allowed border-slate-700 bg-slate-800 text-slate-500"
                : "border-indigo-500/50 bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/30"
            }`}
          >
            <RefreshCw className={`h-4 w-4 ${syncing || loading ? "animate-spin" : ""}`} />
            {syncing ? "同步中..." : loading ? "加载中..." : "刷新数据"}
          </button>
        </div>
      </header>

      {/* Time Range */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <span className="text-sm uppercase tracking-wide text-slate-500">时间范围</span>
        {[1, 7, 14, 30].map((d) => (
          <button
            key={d}
            onClick={() => {
              setDays(d);
              setStartInput("");
              setEndInput("");
            }}
            className={`rounded-full border px-3 py-1.5 text-sm font-semibold transition ${
              days === d
                ? "border-indigo-500 bg-indigo-600 text-white"
                : "border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-500"
            }`}
          >
            {d === 1 ? "今天" : `${d} 天`}
          </button>
        ))}
        <div className="relative" ref={rangePickerRef}>
          <button
            type="button"
            onClick={() => {
              const start = parseDateTimeInput(startInput);
              const end = parseDateTimeInput(endInput);
              if (start && end) {
                setRange({ from: start.date, to: end.date });
                setTimeStart(start.time ?? "00:00");
                setTimeEnd(end.time ?? "23:59");
              } else if (start) {
                setRange({ from: start.date, to: start.date });
                setTimeStart(start.time ?? "00:00");
              } else if (end) {
                setRange({ from: end.date, to: end.date });
                setTimeEnd(end.time ?? "23:59");
              } else {
                setRange(undefined);
                setTimeStart("00:00");
                setTimeEnd("23:59");
              }
              setRangeError(null);
              setRangePickerOpen((prev) => !prev);
            }}
            className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm font-semibold text-slate-200 hover:border-slate-500"
          >
            <CalendarRange className="h-4 w-4 text-indigo-400" />
            <span className="whitespace-nowrap">{rangeLabel}</span>
          </button>

          {rangePickerOpen ? (
            <div className="absolute left-0 z-20 mt-2 min-w-[320px] w-auto rounded-2xl border border-slate-700 bg-slate-900 p-4 shadow-lg">
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-2">
                <DayPicker
                  mode="range"
                  selected={range}
                  onSelect={setRange}
                  numberOfMonths={1}
                  locale={dayPickerLocale}
                  className="rdp rdp-dark text-slate-200"
                  classNames={dayPickerClassNames}
                />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <label className="block text-xs text-slate-400">
                  开始时间
                  <input
                    type="time"
                    value={timeStart}
                    onChange={(e) => setTimeStart(e.target.value)}
                    className="mt-1 w-auto min-w-[120px] rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-white focus:border-indigo-500 focus:outline-none"
                  />
                </label>
                <label className="block text-xs text-slate-400">
                  结束时间
                  <input
                    type="time"
                    value={timeEnd}
                    onChange={(e) => setTimeEnd(e.target.value)}
                    className="mt-1 w-auto min-w-[120px] rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-white focus:border-indigo-500 focus:outline-none"
                  />
                </label>
              </div>
              {rangeError ? <p className="text-xs text-red-400">{rangeError}</p> : null}
              <div className="mt-4 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setRangePickerOpen(false);
                    setRangeError(null);
                  }}
                  className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-500"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!range?.from || !range?.to) {
                      setRangeError("请选择开始和结束时间");
                      return;
                    }
                    if (range.to < range.from) {
                      setRangeError("结束时间需不早于开始时间");
                      return;
                    }
                    if (!/^\d{2}:\d{2}$/.test(timeStart) || !/^\d{2}:\d{2}$/.test(timeEnd)) {
                      setRangeError("时间格式无效");
                      return;
                    }
                    setRangeError(null);
                    const startValue = `${formatDateInput(range.from)}T${timeStart}`;
                    const endValue = `${formatDateInput(range.to)}T${timeEnd}`;
                    setStartInput(startValue);
                    setEndInput(endValue);
                    setDays(diffDaysInclusive(range.from, range.to));
                    setRangePickerOpen(false);
                  }}
                  className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
                >
                  应用
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mt-4 flex items-start gap-3 rounded-xl border border-red-500/50 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          <div>
            <p className="font-semibold">加载失败</p>
            <p className="text-red-300">{error}</p>
          </div>
        </div>
      )}

      {/* Stat Cards */}
      <section className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {loading ? (
          <>
            <div className="h-28 rounded-2xl bg-slate-800/50 ring-1 ring-slate-700 animate-pulse" />
            <div className="h-28 rounded-2xl bg-slate-800/50 ring-1 ring-slate-700 animate-pulse sm:col-span-2 lg:col-span-2" />
            <div className="h-28 rounded-2xl bg-slate-800/50 ring-1 ring-slate-700 animate-pulse" />
            <div className="h-28 rounded-2xl bg-slate-800/50 ring-1 ring-slate-700 animate-pulse" />
          </>
        ) : (
          <>
            <div
              className="animate-card-float rounded-2xl p-5 shadow-sm ring-1 transition-all duration-200 bg-slate-800/50 ring-slate-700 hover:shadow-lg hover:shadow-slate-700/30 hover:ring-slate-600 lg:col-span-1"
              style={{ animationDelay: "0.05s" }}
            >
              <div className="text-sm uppercase tracking-wide text-slate-400">请求数</div>
              <div className="mt-3 text-2xl font-semibold text-white">
                {formatNumberWithCommas(totalStats.requests)}
              </div>
              <p className="mt-2 text-xs text-slate-400/85">
                最近 {days} 天 · 日均 {formatCompactNumber(Math.round(avgRequestsPerDay))}
              </p>
            </div>

            <div
              className="animate-card-float rounded-2xl p-5 shadow-sm ring-1 transition-all duration-200 bg-slate-800/50 ring-slate-700 hover:shadow-lg hover:shadow-slate-700/30 hover:ring-slate-600 sm:col-span-2 lg:col-span-2"
              style={{ animationDelay: "0.1s" }}
            >
              <div className="flex items-center justify-between">
                <div className="text-sm uppercase tracking-wide text-slate-400">TOKENS</div>
                <div className="text-2xl font-bold text-white">
                  {formatNumberWithCommas(totalStats.totalTokens)}
                  <span className="ml-2 text-lg font-normal text-slate-400">
                    ({formatCompactNumber(totalStats.totalTokens)})
                  </span>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">输入</span>
                  <span className="font-medium" style={{ color: "#fb7185" }}>{formatNumberWithCommas(totalStats.inputTokens)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">输出</span>
                  <span className="font-medium" style={{ color: "#4ade80" }}>{formatNumberWithCommas(totalStats.outputTokens)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">思考</span>
                  <span className="font-medium" style={{ color: "#fbbf24" }}>{formatNumberWithCommas(totalStats.reasoningTokens)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">缓存</span>
                  <span className="font-medium" style={{ color: "#c084fc" }}>{formatNumberWithCommas(totalStats.cachedTokens)}</span>
                </div>
              </div>
            </div>

            <div
              className="animate-card-float rounded-2xl p-5 shadow-sm ring-1 transition-all duration-200 bg-gradient-to-br from-emerald-600/20 to-emerald-800/10 ring-emerald-500/30 hover:shadow-lg hover:shadow-emerald-500/20 hover:ring-emerald-500/50 lg:col-span-1"
              style={{ animationDelay: "0.15s" }}
            >
              <div className="text-sm uppercase tracking-wide text-emerald-400">成功率</div>
              <div className={`mt-3 text-2xl font-bold ${rateColor(totalStats.requests, totalStats.errorCount)}`}>
                {fmtRate(totalStats.requests, totalStats.errorCount)}
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-700/60">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-300 transition-all duration-700"
                  style={{ width: `${Math.min(100, Math.max(0, totalSuccessPct))}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-emerald-300/80">
                ✓ {formatNumberWithCommas(Math.max(0, totalStats.requests - totalStats.errorCount))}
                <span className="mx-1.5 text-slate-500">|</span>
                <span className="text-rose-300/80">✗ {formatNumberWithCommas(totalStats.errorCount)}</span>
              </p>
            </div>

            <div
              className="animate-card-float rounded-2xl p-5 shadow-sm ring-1 transition-all duration-200 bg-gradient-to-br from-amber-500/20 to-amber-700/10 ring-amber-400/40 hover:shadow-lg hover:shadow-amber-500/20 hover:ring-amber-400/60 lg:col-span-1"
              style={{ animationDelay: "0.2s" }}
            >
              <div className="text-sm uppercase tracking-wide text-amber-400">总费用</div>
              <div className="mt-3 text-2xl font-semibold text-white">{formatCurrency(totalStats.cost)}</div>
              <p className="mt-2 text-xs text-amber-300/70">按当前筛选时间范围汇总</p>
            </div>
          </>
        )}
      </section>

      {/* Sort Options (Mobile) + Token Legend */}
      {!loading && channels.length > 0 && (
        <div className="mt-6 flex flex-col gap-2 sm:hidden">
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-500">排序</span>
            {([
              ["requests", "请求数"],
              ["totalTokens", "Token"],
              ["cost", "费用"],
              ["successRate", "成功率"]
            ] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => handleSort(key)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                  sortBy === key && sortOrder
                    ? "border-indigo-500 bg-indigo-600/20 text-indigo-400"
                    : "border-slate-700 bg-slate-800 text-slate-400 hover:border-slate-500"
                }`}
              >
                <span className="inline-flex items-center gap-1">
                  {label}
                  {sortBy === key && sortOrder === "desc" && <ArrowDown className="h-3 w-3" />}
                  {sortBy === key && sortOrder === "asc" && <ArrowUp className="h-3 w-3" />}
                </span>
              </button>
            ))}
          </div>
          <TokenLegend />
        </div>
      )}

      {/* Column Headers + Token Legend */}
      {!loading && channels.length > 0 && (
        <div className="mt-4 hidden sm:flex items-center gap-3 px-5 py-1 text-xs uppercase tracking-wide text-slate-500">
          <div className={COL.arrow} />
          <div className={COL.icon} />
          <div className="flex-1 min-w-0">
            <TokenLegend />
          </div>
          <div className="flex items-center gap-3">
            <button
              className={`${COL.requests} inline-flex items-center justify-end gap-1 hover:text-slate-300`}
              onClick={() => handleSort("requests")}
            >
              请求
              {sortBy === "requests" && sortOrder === "desc" && <ArrowDown className="h-3 w-3" />}
              {sortBy === "requests" && sortOrder === "asc" && <ArrowUp className="h-3 w-3" />}
            </button>
            <button
              className={`${COL.tokens} inline-flex items-center justify-end gap-1 hover:text-slate-300`}
              onClick={() => handleSort("totalTokens")}
            >
              Tokens
              {sortBy === "totalTokens" && sortOrder === "desc" && <ArrowDown className="h-3 w-3" />}
              {sortBy === "totalTokens" && sortOrder === "asc" && <ArrowUp className="h-3 w-3" />}
            </button>
            <button
              className={`${COL.cost} inline-flex items-center justify-end gap-1 hover:text-slate-300`}
              onClick={() => handleSort("cost")}
            >
              费用
              {sortBy === "cost" && sortOrder === "desc" && <ArrowDown className="h-3 w-3" />}
              {sortBy === "cost" && sortOrder === "asc" && <ArrowUp className="h-3 w-3" />}
            </button>
            <button
              className={`${COL.rate} inline-flex items-center justify-end gap-1 hover:text-slate-300`}
              onClick={() => handleSort("successRate")}
            >
              成功率
              {sortBy === "successRate" && sortOrder === "desc" && <ArrowDown className="h-3 w-3" />}
              {sortBy === "successRate" && sortOrder === "asc" && <ArrowUp className="h-3 w-3" />}
            </button>
          </div>
        </div>
      )}

      {/* Channel Groups */}
      <section className="mt-1 space-y-2">
        {loading ? (
          <div className="rounded-2xl bg-slate-800/50 ring-1 ring-slate-700 p-12 text-center">
            <RefreshCw className="h-8 w-8 animate-spin mx-auto text-indigo-400" />
            <p className="text-slate-400 mt-3">加载中...</p>
          </div>
        ) : channels.length === 0 ? (
          <div className="rounded-2xl bg-slate-800/50 ring-1 ring-slate-700 p-12 text-center">
            <p className="text-slate-400">暂无数据</p>
          </div>
        ) : (
          groups.map((group) => {
            const isAuth = group.type === "auth";
            const isExpanded = expandedGroups.has(group.name);
            const hasMultiple = group.channels.length > 1;
            const canExpand = isAuth && hasMultiple;

            return (
              <div
                key={group.name}
                className="rounded-2xl ring-1 ring-slate-700 bg-slate-800/50 overflow-hidden transition-all duration-200 hover:ring-slate-600"
              >
                {/* Group Header */}
                <div
                  className={`flex items-center gap-3 px-5 py-3.5 ${canExpand ? "cursor-pointer hover:bg-slate-700/30" : ""}`}
                  onClick={() => canExpand && toggleGroup(group.name)}
                >
                  {/* Arrow - always occupies space for alignment */}
                  <div className={COL.arrow}>
                    {canExpand && (
                      isExpanded
                        ? <ChevronDown className="h-4 w-4 text-slate-500" />
                        : <ChevronRight className="h-4 w-4 text-slate-500" />
                    )}
                  </div>

                  {/* Icon */}
                  <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                    isAuth
                      ? "bg-indigo-500/20 text-indigo-400"
                      : "bg-emerald-500/20 text-emerald-400"
                  }`}>
                    {isAuth ? <Users className="h-4 w-4" /> : <Key className="h-4 w-4" />}
                  </div>

                  {/* Name & Badge & Token Bar */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-white truncate">{group.name}</span>
                      {canExpand && (
                        <span className="shrink-0 rounded-full bg-indigo-500/20 px-2 py-0.5 text-xs font-medium text-indigo-400">
                          {group.channels.length} 账号
                        </span>
                      )}
                    </div>
                    <TokenBar
                      input={group.total.inputTokens}
                      output={group.total.outputTokens}
                      reasoning={group.total.reasoningTokens}
                      cached={group.total.cachedTokens}
                      total={group.total.totalTokens}
                    />
                  </div>

                  {/* Stats - Desktop */}
                  <div className="hidden sm:flex items-center gap-3 text-sm">
                    <div className={COL.requests}>
                      <div className="text-white font-medium">{formatNumberWithCommas(group.total.requests)}</div>
                    </div>
                    <div className={COL.tokens}>
                      <div className="text-white font-medium">{formatNumberWithCommas(group.total.totalTokens)}</div>
                    </div>
                    <div className={COL.cost}>
                      <div className="text-amber-400 font-medium">{formatCurrency(group.total.cost)}</div>
                    </div>
                    <div className={COL.rate}>
                      <div className={`font-medium ${rateColor(group.total.requests, group.total.errorCount)}`}>
                        {fmtRate(group.total.requests, group.total.errorCount)}
                      </div>
                    </div>
                  </div>

                  {/* Stats - Mobile */}
                  <div className="sm:hidden text-right text-sm shrink-0">
                    <div className="text-white font-medium">{formatNumberWithCommas(group.total.requests)} 次</div>
                    <div className="text-amber-400 text-xs">{formatCurrency(group.total.cost)}</div>
                  </div>
                </div>

                {/* Expanded Sub-channels */}
                {canExpand && isExpanded && (
                  <div className="border-t border-slate-700/50">
                    {(sortBy && sortOrder
                      ? [...group.channels].sort((a, b) => {
                          const orderFactor = sortOrder === "asc" ? -1 : 1;
                          return orderFactor * sortByMetric(a, b, sortBy);
                        })
                      : group.channels
                    ).map((ch, idx) => {
                        const accountName = ch.channel.includes("/")
                          ? ch.channel.slice(ch.channel.indexOf("/") + 1)
                          : ch.channel;
                        return (
                          <div
                            key={idx}
                            className={`flex items-center gap-3 px-5 py-2.5 ${
                              idx < group.channels.length - 1 ? "border-b border-slate-700/30" : ""
                            } hover:bg-slate-700/20 transition-colors`}
                          >
                            {/* Arrow placeholder */}
                            <div className={COL.arrow} />
                            {/* Icon placeholder */}
                            <div className={COL.icon} />
                            <div className="flex-1 min-w-0">
                              <span className="text-sm text-slate-300 truncate block">{accountName}</span>
                              <TokenBar
                                input={ch.inputTokens}
                                output={ch.outputTokens}
                                reasoning={ch.reasoningTokens}
                                cached={ch.cachedTokens}
                                total={ch.totalTokens}
                              />
                            </div>
                            {/* Stats - Desktop */}
                            <div className="hidden sm:flex items-center gap-3 text-sm">
                              <div className={COL.requests}>
                                <div className="text-slate-300">{formatNumberWithCommas(ch.requests)}</div>
                              </div>
                              <div className={COL.tokens}>
                                <div className="text-slate-300">{formatNumberWithCommas(ch.totalTokens)}</div>
                              </div>
                              <div className={COL.cost}>
                                <div className="text-amber-400/80">{formatCurrency(ch.cost)}</div>
                              </div>
                              <div className={COL.rate}>
                                <div className={rateColor(ch.requests, ch.errorCount)}>
                                  {fmtRate(ch.requests, ch.errorCount)}
                                </div>
                              </div>
                            </div>
                            {/* Stats - Mobile */}
                            <div className="sm:hidden text-right text-xs shrink-0">
                              <div className="text-slate-300">{formatNumberWithCommas(ch.requests)} 次</div>
                              <div className="text-amber-400/80">{formatCurrency(ch.cost)}</div>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </section>
    </main>
  );
}
