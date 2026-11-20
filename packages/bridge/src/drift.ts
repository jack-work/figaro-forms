import { execFile } from "node:child_process";

export type DriftStatus = "ok" | "drift" | "error" | "missing" | "extra";

export interface DriftChange {
  readonly key: string;
  readonly live: string | null;
  readonly want: string | null;
}

export interface DriftRole {
  readonly role: string;
  readonly id: string;
  readonly status: DriftStatus;
  readonly unseated?: true;
  readonly changes: readonly DriftChange[];
  readonly error?: string;
}

export interface DriftReport {
  readonly generated_at: string;
  readonly source: "figaro-apply --check";
  readonly roles: readonly DriftRole[];
}

export interface CheckRow {
  readonly role: string;
  readonly form: string;
  readonly outcome: string;
  readonly unseated?: boolean;
  readonly outfits?: readonly string[];
  readonly set?: readonly string[];
  readonly remove?: readonly string[];
  readonly error?: string;
}

export interface CheckRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface LiveForm {
  readonly id: string;
  readonly roleName?: string;
}

export interface DriftDaemon {
  forms(): Promise<readonly LiveForm[]>;
  read(id: string): Promise<Record<string, unknown>>;
  fold(outfits: readonly string[]): Promise<Record<string, unknown>>;
}

export class DriftCheckFailed extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): v is readonly string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export function parseCheck(run: CheckRun): CheckRow[] {
  const rows: CheckRow[] = [];
  for (const line of run.stdout.split("\n")) {
    if (line.trim() === "") continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      throw new DriftCheckFailed(`figaro-apply printed a line that is not JSON: ${line.slice(0, 200)}`);
    }
    if (!isRecord(row) || typeof row.role !== "string" || typeof row.form !== "string" || typeof row.outcome !== "string") {
      throw new DriftCheckFailed(`figaro-apply printed a row without role, form and outcome: ${line.slice(0, 200)}`);
    }
    rows.push(row as unknown as CheckRow);
  }
  const failed = rows.filter((r) => r.outcome === "error").length;
  const drifted = rows.filter((r) => r.outcome === "would-apply").length;
  if (run.code === 0 && failed === 0 && drifted === 0 && rows.length > 0) return rows;
  if (run.code === 1 && rows.length > 0) {
    const tally = failed > 0 ? /^figaro-apply: (\d+) of (\d+) roles failed$/m.exec(run.stderr) : /^figaro-apply: (\d+) of (\d+) roles drift;/m.exec(run.stderr);
    if (tally && Number(tally[1]) === (failed || drifted) && Number(tally[2]) === rows.length) return rows;
  }
  const why = run.stderr.trim() || "no output on stderr";
  throw new DriftCheckFailed(`figaro-apply exited ${run.code ?? "on a signal"}: ${why.slice(0, 500)}`);
}

const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));

function at(doc: Record<string, unknown>, dotted: string): unknown {
  let cur: unknown = doc;
  for (const part of dotted.split(".")) {
    if (!isRecord(cur) || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

export const sameForm = (row: string, live: string): boolean => row.length >= 9 && (live === row || live.startsWith(row));

export async function mapDrift(rows: readonly CheckRow[], daemon: DriftDaemon, now: () => Date = () => new Date()): Promise<DriftReport> {
  const live = await daemon.forms();
  const roles: DriftRole[] = [];
  for (const row of rows) {
    const id = live.find((f) => sameForm(row.form, f.id))?.id ?? row.form;
    const seat = row.unseated === true ? { unseated: true as const } : {};
    if (!live.some((f) => sameForm(row.form, f.id))) {
      roles.push({ role: row.role, id, status: "missing", ...seat, changes: [] });
      continue;
    }
    if (row.outcome === "error") {
      roles.push({ role: row.role, id, status: "error", ...seat, changes: [], error: row.error ?? "figaro-apply gave no error text" });
      continue;
    }
    if (row.outcome === "unchanged") {
      roles.push({ role: row.role, id, status: "ok", ...seat, changes: [] });
      continue;
    }
    if (row.outcome !== "would-apply") {
      roles.push({ role: row.role, id, status: "error", ...seat, changes: [], error: `figaro-apply outcome ${JSON.stringify(row.outcome)} is not a check verdict` });
      continue;
    }
    try {
      roles.push({ role: row.role, id, status: "drift", ...seat, changes: await changesOf(row, id, daemon) });
    } catch (e) {
      roles.push({ role: row.role, id, status: "error", ...seat, changes: [], error: e instanceof Error ? e.message : String(e) });
    }
  }
  for (const f of live) {
    if (f.roleName === undefined || rows.some((r) => sameForm(r.form, f.id))) continue;
    roles.push({ role: f.roleName, id: f.id, status: "extra", changes: [] });
  }
  return { generated_at: now().toISOString(), source: "figaro-apply --check", roles };
}

async function changesOf(row: CheckRow, id: string, daemon: DriftDaemon): Promise<DriftChange[]> {
  const set = strings(row.set) ? row.set : [];
  const remove = strings(row.remove) ? row.remove : [];
  if (set.length + remove.length === 0) throw new Error(`${row.role}: figaro-apply says it would apply, but names no key`);
  const current = await daemon.read(id);
  const out: DriftChange[] = [];
  if (set.length) {
    if (!strings(row.outfits) || row.outfits.length === 0) throw new Error(`${row.role}: the check row names no outfits, so the wanted values cannot be folded; figaro-apply is older than the bridge`);
    const want = await daemon.fold(row.outfits);
    for (const key of set) out.push({ key, live: json(at(current, key)), want: json(at(want, key)) });
  }
  for (const key of remove) out.push({ key, live: json(at(current, key)), want: null });
  return out;
}

export function runCheck(command: string, timeoutMs = 120_000): Promise<CheckRun> {
  return new Promise((ok) => {
    execFile(command, ["--check", "-j"], { timeout: timeoutMs, maxBuffer: 16 << 20, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : null) : 0;
      const spawn = err && code === null ? `${err.message}\n` : "";
      ok({ code, stdout, stderr: spawn + stderr });
    });
  });
}

export interface DriftSource {
  get(): Promise<DriftReport>;
}

export function cachedDrift(produce: () => Promise<DriftReport>, ttlMs = 60_000, clock: () => number = Date.now): DriftSource {
  let kept: { at: number; report: DriftReport } | undefined;
  let running: Promise<DriftReport> | undefined;
  return {
    get() {
      if (kept && clock() - kept.at < ttlMs) return Promise.resolve(kept.report);
      running ??= produce()
        .then((report) => {
          kept = { at: clock(), report };
          return report;
        })
        .finally(() => {
          running = undefined;
        });
      return running;
    },
  };
}
