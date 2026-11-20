import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Transcript } from "../../src/aria/fold.js";
import type { Anchor, Metrics, Page } from "../../src/aria/wire.js";
import type { Message } from "../../src/aria/store.js";

interface Step {
  readonly op: string;
  readonly page?: Page;
  readonly quiet?: boolean;
  readonly v?: boolean;
  readonly from?: Anchor;
  readonly to?: Anchor;
  readonly at?: Anchor;
  readonly n?: number;
  readonly len?: number;
  readonly pages?: readonly Page[];
}

interface Fixture {
  readonly name: string;
  readonly note: string;
  readonly steps: readonly Step[];
  readonly expect: readonly Record<string, unknown>[];
}

const dir = new URL("./fixtures/", import.meta.url);
const fixtures = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8")) as Fixture);

const ceiling = 1e18;

function plain(v: unknown): unknown {
  if (typeof v === "number") return v >= ceiling ? Number.MAX_SAFE_INTEGER : v;
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

function stateOf(t: Transcript): Record<string, unknown> {
  const open = t.openKey();
  const missing = t.firstMissing();
  const top = t.held().top();
  return {
    cursor: t.cursor(),
    count: t.count(),
    more: { before: t.moreBefore(), after: t.moreAfter() },
    openTurn: open?.turn ?? 0,
    openFrom: open?.from ?? 0,
    openAnimating: t.openAnimating(),
    heard: t.heard(),
    revision: t.revision(),
    closedRevision: t.closedRevision(),
    firstMissing: missing ?? 0,
    hasMissing: missing !== undefined,
    ...(top ? { top } : {}),
  };
}

function strip<T extends object>(o: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

async function run(box: { t: Transcript }, s: Step): Promise<Record<string, unknown>> {
  const res: Record<string, unknown> = {};
  const t = box.t;
  switch (s.op) {
    case "apply": {
      let desync: number | undefined;
      let metrics: Metrics | undefined;
      let open: Message | undefined;
      const closed: Message[] = [];
      t.hooks = {
        onClosed: (m) => closed.push(m),
        onLive: (m) => (open = m),
        onDesync: (n) => (desync = n),
        onMetrics: (m) => (metrics = m),
      };
      const applied = t.apply(s.page as Page, s.quiet ? "quiet" : "notify");
      const got = s.quiet ? applied.closed : closed;
      if (got.length > 0) res.closed = got;
      if (open) res.open = open;
      if (desync !== undefined) res.desync = desync;
      if (metrics) res.metrics = metrics;
      break;
    }
    case "setMoreBefore":
      t.setMoreBefore(s.v ?? false);
      break;
    case "setMoreAfter":
      t.setMoreAfter(s.v ?? false);
      break;
    case "query":
    {
      const segs = t.query(s.from as Anchor, s.to as Anchor).map((seg) => strip({ msgs: seg.msgs, gap: seg.gap }));
      if (segs.length > 0) res.segments = segs;
      break;
    }
    case "evictBefore":
      t.evictBefore(s.at as Anchor);
      break;
    case "closedLimit":
      t.setClosedLimit(s.n ?? 0);
      break;
    case "cloneBelow":
      box.t = t.cloneBelow(s.n ?? 0);
      break;
    case "tailFrom": {
      const a = t.tailFrom(s.n ?? 0);
      res.anchor = a ?? { turn: 0, node: 0 };
      res.found = a !== undefined;
      break;
    }
    case "skip": {
      const a = t.skip(s.at as Anchor, s.n ?? 0);
      res.anchor = a ?? { turn: 0, node: 0 };
      res.found = a !== undefined;
      break;
    }
    case "before": {
      const r = t.before(s.at as Anchor, s.n ?? 0);
      res.anchor = r.at;
      res.moved = r.moved;
      break;
    }
    case "contiguous":
      res.flag = t.contiguous(s.at as Anchor);
      break;
    case "view": {
      const v = t.view();
      res.view = strip({ closed: v.closed, open: v.open });
      break;
    }
    case "inquiryOf": {
      const q = t.inquiryOf(s.n ?? 0);
      res.flag = q !== undefined;
      if (q) res.inquiry = strip({ text: q.text, segments: q.segments, formDeltas: q.formDeltas, lt: q.lt });
      break;
    }
    case "setTurnLen":
      t.held().setTurnLen(s.n ?? 0, s.len ?? 0);
      break;
    case "ensure": {
      const calls: { before: Anchor; limit: number }[] = [];
      let next = 0;
      t.setFetcher(async (before, limit) => {
        calls.push({ before, limit });
        const p = s.pages?.[next];
        if (!p) throw new Error("no more pages");
        next++;
        return p;
      });
      try {
        await t.ensure(s.from as Anchor, s.to as Anchor);
      } catch (e) {
        res.err = (e as Error).message;
      }
      if (calls.length > 0) res.fetched = calls;
      break;
    }
    default:
      throw new Error(`unknown op ${s.op}`);
  }
  res.state = stateOf(box.t);
  return res;
}

describe("the TypeScript store replays what sdk/aria v0.78.1 folded", () => {
  it("has fixtures to hold it to", () => {
    expect(fixtures.length).toBeGreaterThan(20);
  });

  for (const f of fixtures) {
    it(`${f.name}: ${f.note}`, async () => {
      const box = { t: new Transcript() };
      for (let i = 0; i < f.steps.length; i++) {
        const step = f.steps[i] as Step;
        const got = plain(JSON.parse(JSON.stringify(await run(box, step))));
        expect(got, `step ${i} (${step.op})`).toEqual(plain(f.expect[i]));
      }
    });
  }
});
