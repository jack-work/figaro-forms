export const gatewayMethods = [
  "angelus.hello",
  "angelus.outfits",
  "figaro.follow",
  "figaro.unfollow",
  "figaro.form",
  "figaro.read",
  "figaro.qua",
  "figaro.interrupt",
  "figaro.queued",
  "figaro.queue.delete",
  "figaro.queue.update",
  "figaro.fork",
  "figaro.list",
  "figaro.create",
  "figaro.set",
] as const;

export const allowed: ReadonlySet<string> = new Set(gatewayMethods);

const permitted: Readonly<Record<string, ReadonlySet<string>>> = {
  "figaro.qua": new Set(["figaro_id", "text", "images", "traceparent", "attachments", "dictation"]),
  "figaro.fork": new Set(["figaro_id", "at_turn", "at_lt"]),
  "figaro.create": new Set(["outfits"]),
  "angelus.outfits": new Set(["spec"]),
  "figaro.set": new Set(["figaro_id", "patch", "client", "seq"]),
  "figaro.interrupt": new Set(["figaro_id", "queue", "traceparent"]),
  "figaro.queued": new Set(["figaro_id"]),
  "figaro.queue.delete": new Set(["figaro_id", "epoch", "ids"]),
  "figaro.queue.update": new Set(["figaro_id", "epoch", "id", "text"]),
};

export const queueDispositions: ReadonlySet<unknown> = new Set([undefined, "keep", "clear"]);

export function forbiddenField(method: string, params: unknown): string | undefined {
  const keys = permitted[method];
  if (!keys) return undefined;
  if (typeof params !== "object" || params === null || Array.isArray(params)) return undefined;
  for (const k of Object.keys(params)) if (!keys.has(k)) return k;
  return undefined;
}
