import { atom, type WritableAtom } from "jotai/vanilla";

const families = new WeakMap<object, Map<string, unknown>>();

export function memoByClient<T>(client: object, key: string, make: () => T): T {
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

export function holdTicker<S>(
  hold: () => S,
  release: () => void,
  listen: (held: S, bump: () => void) => () => void,
): WritableAtom<number, [(n: number) => number], void> {
  const tick = atom(0);
  tick.onMount = (set) => {
    const off = listen(hold(), () => set((n) => n + 1));
    return () => {
      off();
      release();
    };
  };
  return tick as unknown as WritableAtom<number, [(n: number) => number], void>;
}
