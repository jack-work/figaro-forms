import { atom, type Atom, type WritableAtom } from "jotai/vanilla";
import type { AriaClient, AriaList, ListOptions } from "./client.js";
import type { AriaEvent, EventFilter } from "./events.js";
import type { AriaSnapshot, AriaStream, Phase } from "./stream.js";

const families = new WeakMap<AriaClient, Map<string, unknown>>();

function memo<T>(client: AriaClient, key: string, make: () => T): T {
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

function ticker(client: AriaClient, aria: string, listen: (s: AriaStream, bump: () => void) => () => void): WritableAtom<number, [(n: number) => number], void> {
  const tick = atom(0);
  tick.onMount = (set) => {
    const stream = client.retain(aria);
    const off = listen(stream, () => set((n) => n + 1));
    return () => {
      off();
      client.release(aria);
    };
  };
  return tick as unknown as WritableAtom<number, [(n: number) => number], void>;
}

export function ariaAtom(client: AriaClient, aria: string): Atom<AriaSnapshot> {
  return memo(client, `s\0${aria}`, () => {
    const tick = ticker(client, aria, (s, bump) => s.onChange(bump));
    return atom((get) => {
      get(tick);
      return client.peek(aria).snapshot();
    });
  });
}

export function ariaPhaseAtom(client: AriaClient, aria: string): Atom<Phase> {
  return memo(client, `p\0${aria}`, () => {
    const tick = ticker(client, aria, (s, bump) => s.onChange(bump));
    return atom((get) => {
      get(tick);
      return client.peek(aria).state;
    });
  });
}

export function ariaEventAtom(client: AriaClient, aria: string, filter?: EventFilter): Atom<AriaEvent | undefined> {
  return memo(client, `e\0${aria}\0${filter === undefined ? "" : JSON.stringify(filter)}`, () => {
    let latest: AriaEvent | undefined;
    const tick = ticker(client, aria, (s, bump) =>
      s.subscribe((e) => {
        latest = e;
        bump();
      }, filter),
    );
    return atom((get) => {
      get(tick);
      return latest;
    });
  });
}

export function ariaListAtom(client: AriaClient, o: ListOptions = {}): WritableAtom<Promise<AriaList>, [], void> {
  return memo(client, `l\0${JSON.stringify(o)}`, () => {
    const rev = atom(0);
    return atom(
      (get) => {
        get(rev);
        return client.list(o);
      },
      (_get, set) => set(rev, (n) => n + 1),
    );
  });
}
