import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export const traceparentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const zeroTrace = "0".repeat(32);
const zeroSpan = "0".repeat(16);

export interface SpanContext {
  readonly traceId: string;
  readonly spanId: string;
}

export type SpanValue = string | number | boolean;

export interface Span {
  readonly context: SpanContext;
  readonly traceparent: string;
  set(key: string, value: SpanValue): void;
  fail(message: string): void;
  end(): void;
}

export interface FinishedSpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly startNs: bigint;
  readonly endNs: bigint;
  readonly attributes: Readonly<Record<string, SpanValue>>;
  readonly error: string | undefined;
}

export interface Tracer {
  readonly recording: boolean;
  start(name: string, parent: SpanContext | string | undefined, attributes?: Record<string, SpanValue>): Span;
}

export function parseTraceparent(tp: string | undefined): SpanContext | undefined {
  const m = tp === undefined ? null : traceparentPattern.exec(tp);
  if (!m || m[1] === zeroTrace || m[2] === zeroSpan) return undefined;
  return { traceId: m[1]!, spanId: m[2]! };
}

export const traceparentOf = (c: SpanContext): string => `00-${c.traceId}-${c.spanId}-01`;

const nowNs = (): bigint => BigInt(Date.now()) * 1_000_000n;

export function recordingTracer(sink: (s: FinishedSpan) => void, recording = true): Tracer {
  return {
    recording,
    start(name, parent, attributes = {}) {
      const p = typeof parent === "string" ? parseTraceparent(parent) : parent;
      const context = { traceId: p?.traceId ?? randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex") };
      const attrs: Record<string, SpanValue> = { ...attributes };
      const startNs = nowNs();
      let error: string | undefined;
      let ended = false;
      return {
        context,
        traceparent: traceparentOf(context),
        set: (k, v) => void (attrs[k] = v),
        fail: (m) => void (error = m),
        end: () => {
          if (ended) return;
          ended = true;
          sink({ name, traceId: context.traceId, spanId: context.spanId, parentSpanId: p?.spanId, startNs, endNs: nowNs(), attributes: attrs, error });
        },
      };
    },
  };
}

export const noTracer: Tracer = recordingTracer(() => {}, false);

const attrValue = (v: SpanValue): Record<string, unknown> =>
  typeof v === "boolean" ? { boolValue: v } : typeof v === "number" ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : { stringValue: v };

export function otlpBody(service: string, spans: readonly FinishedSpan[]): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
        scopeSpans: [
          {
            scope: { name: service },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: 2,
              startTimeUnixNano: s.startNs.toString(),
              endTimeUnixNano: s.endNs.toString(),
              attributes: Object.entries(s.attributes).map(([key, v]) => ({ key, value: attrValue(v) })),
              status: s.error !== undefined ? { code: 2, message: s.error } : { code: 0 },
            })),
          },
        ],
      },
    ],
  });
}

export interface OtlpOptions {
  readonly endpoint: string;
  readonly service: string;
  readonly log: (line: string) => void;
  readonly flushMs?: number;
  readonly maxBatch?: number;
  readonly maxQueue?: number;
  readonly deadlineMs?: number;
  readonly closeMs?: number;
}

export interface Exporter {
  readonly tracer: Tracer;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export function otlpExporter(o: OtlpOptions): Exporter {
  const url = new URL("v1/traces", o.endpoint.endsWith("/") ? o.endpoint : o.endpoint + "/");
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`--otlp-endpoint ${o.endpoint} is not an http(s) URL`);
  const maxBatch = o.maxBatch ?? 256;
  const maxQueue = o.maxQueue ?? 4096;
  const closeMs = o.closeMs ?? 3_000;
  const queue: FinishedSpan[] = [];
  let lastComplaint = 0;
  const complain = (line: string): void => {
    const now = Date.now();
    if (now - lastComplaint < 60_000) return;
    lastComplaint = now;
    o.log(`traces: ${line} (further errors this minute are not logged)`);
  };
  const deadlineMs = o.deadlineMs ?? 10_000;
  const post = (body: string): Promise<void> =>
    new Promise((ok) => {
      let settled = false;
      const settle = (why?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (why) complain(why);
        ok();
      };
      const send = url.protocol === "https:" ? httpsRequest : httpRequest;
      const req = send(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        res.once("end", () => settle(status >= 300 ? `collector answered ${status}; batch dropped` : undefined));
        res.once("error", (e) => settle(`collector reply failed (${e.message}); batch dropped`));
      });
      const deadline = setTimeout(() => {
        req.destroy();
        settle(`collector took over ${deadlineMs} ms; batch dropped`);
      }, deadlineMs);
      deadline.unref();
      req.once("error", (e) => settle(`collector unreachable (${e.message}); batch dropped`));
      req.end(body);
    });
  let inFlight = 0;
  let running: Promise<void> | undefined;
  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      const batch = queue.splice(0, maxBatch);
      inFlight = batch.length;
      await post(otlpBody(o.service, batch));
      inFlight = 0;
    }
  };
  const flush = (): Promise<void> => (running ??= drain().finally(() => (running = undefined)));
  const timer = setInterval(() => void flush(), o.flushMs ?? 5_000);
  timer.unref();
  return {
    tracer: recordingTracer((s) => {
      if (queue.length + inFlight >= maxQueue) {
        complain(`queue full at ${maxQueue} spans; span dropped`);
        return;
      }
      queue.push(s);
      if (queue.length >= maxBatch) void flush();
    }),
    flush,
    close: async () => {
      clearInterval(timer);
      let gaveUp: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<void>((ok) => {
        gaveUp = setTimeout(() => {
          complain(`spans not flushed within ${closeMs} ms of shutdown; dropped`);
          ok();
        }, closeMs);
      });
      await Promise.race([flush(), late]);
      clearTimeout(gaveUp);
    },
  };
}
