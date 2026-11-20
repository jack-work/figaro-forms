import { RpcError } from "../rpc.js";
import { errDeniedCode, errDormantCode, errMovedCode } from "./wire.js";

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
  if (err.code === errDeniedCode) return "denied";
  if (err.code === errDormantCode) return "dormant";
  if (err.code === errMovedCode) return "moved";
  if (err.code === -32041) return "unavailable";
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
