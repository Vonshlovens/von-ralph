/** Client for the `ralph serve` /v1 API (same origin; dev proxies /v1). */

export type RunStatus = "running" | "finished" | "failed" | "stopped";
export type Mode = "run" | "plan" | "build" | "reverse";
export type Harness = "claude" | "codex" | "opencode" | "gh";

export interface Run {
  id: string;
  name: string;
  pid: number;
  harness: Harness;
  model: string | null;
  effort: string | null;
  dir: string;
  prompt: string;
  maxIterations: number;
  marathon: boolean;
  iterationTimeoutSeconds: number;
  status: RunStatus;
  currentIteration: number;
  stopReason: string | null;
  startedAt: string;
  updatedAt: string;
  beadId: string | null;
  mode: Mode;
  scope: string | null;
  callbackUrl: string | null;
  alive: boolean;
  lastOutcome: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface Iteration {
  iteration: number;
  outcome: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  sessionId: string | null;
  attachId: string | null;
  headBefore: string | null;
  headAfter: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  lastAssistant: string | null;
  error: string | null;
  validateOk: boolean | null;
  planOpen: number | null;
}

/** A normalized event (see src/domain.ts RalphEvent); fields vary by type. */
export interface RalphEvent {
  type: string;
  ts: string;
  run: string;
  instance: string;
  iteration: number;
  [k: string]: unknown;
}

export interface StoredEvent {
  id: number;
  event: RalphEvent;
}

export interface Report {
  stopReason: string | null;
  iterations: number;
  durationMs: number;
  outcomes: Record<string, number>;
  tokens: { input: number; output: number };
  costUsd: number;
  commits: string[];
  diffStat: string;
  plan: {
    backend?: string;
    before: { open?: number; total?: number };
    after: { open?: number; total?: number; ready?: number };
  } | null;
  validate: {
    runs: number;
    failures: number;
    last: {
      ok: boolean;
      results: { command: string; exitCode: number | null; output: string }[];
    } | null;
  };
  needsHuman: string[];
  lastWords: string | null;
  logPath: string;
}

export interface Schedule {
  name: string;
  calendar: string;
  cron: string | null;
  args: string[];
  dir: string;
  persistent: boolean;
  enabled: boolean;
  nextRun: string | null;
  lastRun: string | null;
  lastResult: string | null;
  lastExitCode: number | null;
  running: boolean;
}

export interface StartRequest {
  mode: Mode;
  dir: string;
  prompt?: string | null;
  name?: string | null;
  harness?: Harness | null;
  model?: string | null;
  effort?: string | null;
  max?: number | null;
  timeout?: number | null;
  marathon?: boolean | null;
  scope?: string | null;
  bead?: string | null;
  callbackUrl?: string | null;
}

const TOKEN_KEY = "ralph.token";

export const auth = $state({ token: readToken(), needed: false });

function readToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(token: string) {
  auth.token = token;
  auth.needed = false;
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* private mode: keep it in memory */
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (auth.token !== "") headers.set("authorization", `Bearer ${auth.token}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) auth.needed = true;
  const text = await res.text();
  const data = text === "" ? {} : (JSON.parse(text) as unknown);
  if (!res.ok) {
    const msg = (data as { error?: string }).error ?? `HTTP ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

const post = <T>(path: string, body: unknown = {}) =>
  call<T>(path, { method: "POST", body: JSON.stringify(body) });

const enc = encodeURIComponent;

export const api = {
  runs: (all = false) => call<{ runs: Run[] }>(`/v1/runs${all ? "?all=1" : ""}`),
  run: (id: string) =>
    call<{ run: Run; iterations: Iteration[]; logPath: string }>(`/v1/runs/${enc(id)}`),
  report: (id: string) => call<Report>(`/v1/runs/${enc(id)}/report`),
  start: (req: StartRequest) => post<{ run: Run }>("/v1/runs", req),
  steer: (id: string, text: string) =>
    post<{ steerId: number }>(`/v1/runs/${enc(id)}/steer`, { text }),
  stop: (id: string, graceful: boolean) =>
    post<{ state: string; message: string }>(`/v1/runs/${enc(id)}/stop`, { graceful }),
  restart: (id: string, max?: number) =>
    post<{ run: Run }>(`/v1/runs/${enc(id)}/restart`, max === undefined ? {} : { max }),
  schedules: () => call<{ schedules: Schedule[] }>("/v1/schedules"),
  runSchedule: (name: string) => post<{ started: string }>(`/v1/schedules/${enc(name)}/run`),
};

/** EventSource with the token as a query param (EventSource cannot set headers). */
export function stream(path: string, params: Record<string, string> = {}): EventSource {
  const q = new URLSearchParams(params);
  if (auth.token !== "") q.set("token", auth.token);
  const qs = q.toString();
  return new EventSource(qs === "" ? path : `${path}?${qs}`);
}
