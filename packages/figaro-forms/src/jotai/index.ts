import { atom, type Atom, type WritableAtom } from "jotai/vanilla";
import type { FormRef, FormsClient } from "../client.js";
import type { Json, JsonObject } from "../json.js";
import type { PathLike } from "../path.js";
import type { EditResult, FormStatus, Replica } from "../replica.js";

type ValueAtom = WritableAtom<Json | undefined, [Json | undefined], Promise<EditResult>>;

const families = new WeakMap<FormsClient, Map<string, unknown>>();

function memo<T>(client: FormsClient, key: string, make: () => T): T {
  let m = families.get(client);
  if (!m) {
    m = new Map();
    families.set(client, m);
  }
  let a = m.get(key) as T | undefined;
  if (a === undefined) {
    a = make();
    m.set(key, a);
  }
  return a;
}

const refKey = (ref: string | FormRef): string => (typeof ref === "string" ? ref : `${ref.id}/${ref.intrinsic ?? "state"}`);

function ticker(client: FormsClient, ref: string | FormRef, listen: (r: Replica, bump: () => void) => () => void) {
  const tick = atom(0);
  tick.onMount = (set) => {
    const r = client.retain(ref);
    const off = listen(r, () => set((n) => n + 1));
    return () => {
      off();
      client.release(ref);
    };
  };
  return tick;
}

export function formValueAtom(client: FormsClient, ref: string | FormRef, path: PathLike): ValueAtom {
  const pathKey = typeof path === "string" ? path : JSON.stringify(path);
  return memo(client, `v\0${refKey(ref)}\0${pathKey}`, () => {
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
  return memo(client, `f\0${refKey(ref)}`, () => {
    const tick = ticker(client, ref, (r, bump) => r.subscribe([], bump));
    return atom((get) => {
      get(tick);
      return client.peek(ref).root;
    });
  });
}

export function formStatusAtom(client: FormsClient, ref: string | FormRef): Atom<FormStatus> {
  return memo(client, `s\0${refKey(ref)}`, () => {
    const tick = ticker(client, ref, (r, bump) => r.onStatus(bump));
    return atom((get) => {
      get(tick);
      return client.peek(ref).status;
    });
  });
}
