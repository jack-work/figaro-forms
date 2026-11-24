import { useEffect, useMemo, useSyncExternalStore } from "react";

export function useStore<T>(subscribe: (fn: () => void) => () => void, get: () => T): T {
  return useSyncExternalStore(subscribe, get, get);
}

export function useHeld<S>(client: object, key: string | undefined, peek: () => S, retain: () => void, release: () => void): S | undefined {
  const held = useMemo(() => (key === undefined ? undefined : peek()), [client, key]);
  useEffect(() => {
    if (key === undefined) return;
    retain();
    return release;
  }, [client, key]);
  return held;
}
