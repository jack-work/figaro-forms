import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export const bounds = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

export type Attrs = Readonly<Record<string, string>>;

export interface Metrics {
  ms(name: string, value: number, attrs: Attrs): void;
  count(name: string, attrs: Attrs, n?: number): void;
}

export const noMetrics: Metrics = { ms: () => {}, count: () => {} };

interface Hist {
  readonly name: string;
  readonly attrs: Attrs;
  count: number;
  sum: number;
  readonly buckets: number[];
}

interface Sum {
  readonly name: string;
  readonly attrs: Attrs;
  value: number;
}

const keyOf = (name: string, attrs: Attrs): string => `${name}\u0000${JSON.stringify(Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b)))}`;
const attrList = (a: Attrs): { key: string; value: { stringValue: string } }[] => Object.entries(a).map(([key, v]) => ({ key, value: { stringValue: v } }));

export class Recorder implements Metrics {
  private hists = new Map<string, Hist>();
  private sums = new Map<string, Sum>();
  private since = Date.now();

  ms(name: string, value: number, attrs: Attrs): void {
    if (!Number.isFinite(value) || value < 0) return;
    const k = keyOf(name, attrs);
    let h = this.hists.get(k);
    if (!h) {
      h = { name, attrs, count: 0, sum: 0, buckets: new Array<number>(bounds.length + 1).fill(0) };
      this.hists.set(k, h);
    }
    h.count++;
    h.sum += value;
    let i = bounds.findIndex((b) => value <= b);
    if (i < 0) i = bounds.length;
    h.buckets[i]!++;
  }

  count(name: string, attrs: Attrs, n = 1): void {
    const k = keyOf(name, attrs);
    const s = this.sums.get(k);
    if (s) s.value += n;
    else this.sums.set(k, { name, attrs, value: n });
  }

  drain(service: string, now = Date.now()): string | undefined {
    if (this.hists.size === 0 && this.sums.size === 0) return undefined;
    const start = `${BigInt(this.since) * 1_000_000n}`;
    const end = `${BigInt(now) * 1_000_000n}`;
    const metrics = [
      ...[...this.hists.values()].map((h) => ({
        name: h.name,
        unit: "ms",
        histogram: {
          aggregationTemporality: 1,
          dataPoints: [{ attributes: attrList(h.attrs), startTimeUnixNano: start, timeUnixNano: end, count: String(h.count), sum: h.sum, bucketCounts: h.buckets.map(String), explicitBounds: bounds }],
        },
      })),
      ...[...this.sums.values()].map((s) => ({
        name: s.name,
        sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: [{ attributes: attrList(s.attrs), startTimeUnixNano: start, timeUnixNano: end, asInt: String(s.value) }] },
      })),
    ];
    this.hists = new Map();
    this.sums = new Map();
    this.since = now;
    return JSON.stringify({ resourceMetrics: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] }, scopeMetrics: [{ scope: { name: service }, metrics }] }] });
  }
}

export interface MetricsExporter {
  readonly metrics: Metrics;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export function otlpMetrics(o: { endpoint: string; service: string; log: (line: string) => void; everyMs?: number; deadlineMs?: number }): MetricsExporter {
  const url = new URL("v1/metrics", o.endpoint.endsWith("/") ? o.endpoint : o.endpoint + "/");
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`--otlp-endpoint ${o.endpoint} is not an http(s) URL`);
  const rec = new Recorder();
  let last = 0;
  const complain = (line: string): void => {
    if (Date.now() - last < 60_000) return;
    last = Date.now();
    o.log(`metrics: ${line} (further errors this minute are not logged)`);
  };
  const post = (body: string): Promise<void> =>
    new Promise((ok) => {
      let settled = false;
      const done = (why?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (why) complain(why);
        ok();
      };
      const send = url.protocol === "https:" ? httpsRequest : httpRequest;
      const req = send(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        res.once("end", () => done(status >= 300 ? `collector answered ${status}; points dropped` : undefined));
      });
      const timer = setTimeout(() => {
        req.destroy();
        done("collector too slow; points dropped");
      }, o.deadlineMs ?? 10_000);
      timer.unref();
      req.once("error", (e) => done(`collector unreachable (${e.message}); points dropped`));
      req.end(body);
    });
  let running: Promise<void> | undefined;
  const flush = (): Promise<void> => {
    const body = rec.drain(o.service);
    if (!body) return running ?? Promise.resolve();
    running = (running ?? Promise.resolve()).then(() => post(body));
    return running;
  };
  const t = setInterval(() => void flush(), o.everyMs ?? 10_000);
  t.unref();
  return {
    metrics: rec,
    flush,
    close: async () => {
      clearInterval(t);
      await Promise.race([flush(), new Promise<void>((ok) => setTimeout(ok, 3_000).unref())]);
    },
  };
}
