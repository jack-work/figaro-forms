import { RpcError } from "../rpc.js";
import { errDenied, errDormant, errFormUnavailable, errMoved } from "../wire.js";

export type RefusalKind = "denied" | "not_found" | "dormant" | "moved" | "unavailable";

export interface AriaRefusal {
  readonly kind: RefusalKind;
  readonly code: number;
  readonly message: string;
}

export function ariaRefusal(err: unknown): AriaRefusal | undefined {
  if (!(err instanceof RpcError)) return undefined;
  const kind = classify(err);
  return kind ? { kind, code: err.code, message: err.message } : undefined;
}

function classify(err: RpcError): RefusalKind | undefined {
  if (err.code === errDenied) return "denied";
  if (err.code === errDormant) return "dormant";
  if (err.code === errMoved) return "moved";
  if (err.code === errFormUnavailable) return "unavailable";
  if (/\bnot found\b/i.test(err.message)) return "not_found";
  return undefined;
}

export class AriaUnavailable extends Error {
  readonly refusal: AriaRefusal;

  constructor(aria: string, refusal: AriaRefusal) {
    super(`${aria}: ${refusal.kind}: ${refusal.message}`);
    this.name = "AriaUnavailable";
    this.refusal = refusal;
  }
}
