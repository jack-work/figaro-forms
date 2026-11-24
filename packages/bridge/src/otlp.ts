import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export interface Collector {
  post(body: string): Promise<void>;
  complain(line: string): void;
}

export interface CollectorOptions {
  readonly endpoint: string;
  readonly path: string;
  readonly label: string;
  readonly dropped: string;
  readonly log: (line: string) => void;
  readonly deadlineMs?: number;
}

export function otlpCollector(o: CollectorOptions): Collector {
  const url = new URL(o.path, o.endpoint.endsWith("/") ? o.endpoint : o.endpoint + "/");
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`--otlp-endpoint ${o.endpoint} is not an http(s) URL`);
  const deadlineMs = o.deadlineMs ?? 10_000;
  let lastComplaint = 0;
  const complain = (line: string): void => {
    const now = Date.now();
    if (now - lastComplaint < 60_000) return;
    lastComplaint = now;
    o.log(`${o.label}: ${line} (further errors this minute are not logged)`);
  };
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
        res.once("end", () => settle(status >= 300 ? `collector answered ${status}; ${o.dropped} dropped` : undefined));
        res.once("error", (e) => settle(`collector reply failed (${e.message}); ${o.dropped} dropped`));
      });
      const deadline = setTimeout(() => {
        req.destroy();
        settle(`collector took over ${deadlineMs} ms; ${o.dropped} dropped`);
      }, deadlineMs);
      deadline.unref();
      req.once("error", (e) => settle(`collector unreachable (${e.message}); ${o.dropped} dropped`));
      req.end(body);
    });
  return { post, complain };
}
