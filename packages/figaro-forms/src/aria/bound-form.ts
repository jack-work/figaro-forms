import type { FormsClient } from "../client.js";
import type { Json, JsonObject } from "../json.js";
import type { Freshness, Phase, Replica, EditResult } from "../replica.js";
import type { Refusal } from "../access.js";
import type { FormAccess } from "../wire.js";
import type { AriaClient } from "./client.js";
import { errorOf, feedOf, idle, ReplicaFeed, readyOf, type Feed } from "./feeds.js";

export interface BoundFormState {
  readonly aria: string;
  readonly ready: boolean;
  readonly freshness: Freshness;
  readonly phase: Phase;
  readonly error: string | undefined;
  readonly refusal: Refusal | undefined;
  readonly access: FormAccess | undefined;
  readonly version: number;
  readonly root: JsonObject;
}

export function boundFormFeed(forms: () => FormsClient, aria: string): Feed<BoundFormState> {
  return new ReplicaFeed<BoundFormState>(
    forms,
    aria,
    (r) => ({
      aria,
      ready: readyOf(r),
      freshness: r.status.freshness,
      phase: r.status.phase,
      error: errorOf(r),
      refusal: r.status.refusal,
      access: r.status.access,
      version: r.status.version,
      root: r.root,
    }),
    { aria, ...idle, phase: "loading", refusal: undefined, access: undefined, version: 0, root: {} },
  );
}

export interface BoundFormWriter {
  set(path: string, value: Json): Promise<EditResult>;
  unset(path: string): Promise<EditResult>;
}

export function boundFormWriter(forms: () => FormsClient, aria: string): BoundFormWriter {
  const through = async (edit: (r: Replica) => Promise<EditResult>): Promise<EditResult> => {
    const client = forms();
    const r = client.retain(aria);
    try {
      return await edit(r);
    } finally {
      client.release(aria);
    }
  };
  return {
    set: (path, value) => through((r) => r.set(path, value)),
    unset: (path) => through((r) => r.unset(path)),
  };
}

export const boundFormWriterOf = (client: AriaClient, aria: string): BoundFormWriter => boundFormWriter(() => client.forms, aria);

export const boundFormFeedOf = (client: AriaClient, aria: string): Feed<BoundFormState> =>
  feedOf(client, `bound\0${aria}`, () => boundFormFeed(() => client.forms, aria));
