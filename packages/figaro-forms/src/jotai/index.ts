import { atom, type Atom, type WritableAtom } from "jotai/vanilla";
import { formKey, type FormRef, type FormsClient } from "../client.js";
import { holdTicker, memoByClient } from "./shared.js";
import type { Json, JsonObject } from "../json.js";
import type { PathLike } from "../path.js";
import type { EditResult, FormStatus, Replica } from "../replica.js";

type ValueAtom = WritableAtom<Json | undefined, [Json | undefined], Promise<EditResult>>;

function ticker(client: FormsClient, ref: string | FormRef, listen: (r: Replica, bump: () => void) => () => void) {
  return holdTicker(() => client.retain(ref), () => client.release(ref), listen);
}

export function formValueAtom(client: FormsClient, ref: string | FormRef, path: PathLike): ValueAtom {
  const pathKey = typeof path === "string" ? path : JSON.stringify(path);
  return memoByClient(client, `v\0${formKey(ref)}\0${pathKey}`, () => {
    const tick = ticker(client, ref, (r, bump) => r.subscribe(path, bump));
    return atom(
      (get) => {
        get(tick);
        return client.peek(ref).get(path);
      },
      (_get, _set, value: Json | undefined) => {
        const r = client.peek(ref);
        return value === undefined ? r.unset(path) : r.set(path, value);
      },
    );
  });
}

export function formAtom(client: FormsClient, ref: string | FormRef): Atom<JsonObject> {
  return memoByClient(client, `f\0${formKey(ref)}`, () => {
    const tick = ticker(client, ref, (r, bump) => r.subscribe([], bump));
    return atom((get) => {
      get(tick);
      return client.peek(ref).root;
    });
  });
}

export function formStatusAtom(client: FormsClient, ref: string | FormRef): Atom<FormStatus> {
  return memoByClient(client, `s\0${formKey(ref)}`, () => {
    const tick = ticker(client, ref, (r, bump) => r.onStatus(bump));
    return atom((get) => {
      get(tick);
      return client.peek(ref).status;
    });
  });
}
