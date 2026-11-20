import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ConnectionState } from "../rpc.js";
import type { AriaClient, AriaList, ListOptions } from "./client.js";
import type { AppliedFrame, AriaSnapshot, AriaStream, Phase } from "./stream.js";

const Context = createContext<AriaClient | null>(null);

export function AriaProvider(props: { readonly client: AriaClient; readonly children?: ReactNode }): ReactNode {
  return createElement(Context.Provider, { value: props.client }, props.children);
}

export function useAriaClient(): AriaClient {
  const c = useContext(Context);
  if (!c) throw new Error("useAriaClient: no AriaProvider above this component");
  return c;
}

export function useAriaStream(aria: string | undefined): AriaStream | undefined {
  const client = useAriaClient();
  const stream = useMemo(() => (aria === undefined ? undefined : client.peek(aria)), [client, aria]);
  useEffect(() => {
    if (aria === undefined) return;
    client.retain(aria);
    return () => client.release(aria);
  }, [client, aria]);
  return stream;
}

const never = (): (() => void) => () => {};

export function useAria(aria: string | undefined): AriaSnapshot | undefined {
  const stream = useAriaStream(aria);
  const subscribe = useCallback((fn: () => void) => (stream ? stream.onChange(fn) : never()), [stream]);
  const get = useCallback(() => stream?.snapshot(), [stream]);
  return useSyncExternalStore(subscribe, get, get);
}

export function useAriaPhase(aria: string | undefined): Phase | undefined {
  const stream = useAriaStream(aria);
  const subscribe = useCallback((fn: () => void) => (stream ? stream.onChange(fn) : never()), [stream]);
  const get = useCallback(() => stream?.state, [stream]);
  return useSyncExternalStore(subscribe, get, get);
}

export function useAriaFrames(aria: string | undefined, handler: (a: AppliedFrame) => void): void {
  const stream = useAriaStream(aria);
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!stream) return;
    return stream.onFrame((a) => latest.current(a));
  }, [stream]);
}

export function useAriaConnection(): ConnectionState {
  const client = useAriaClient();
  const subscribe = useCallback((fn: () => void) => client.connection.onState(fn), [client]);
  const get = useCallback(() => client.connection.state, [client]);
  return useSyncExternalStore(subscribe, get, get);
}

export interface AriaListState {
  readonly list: AriaList | undefined;
  readonly error: unknown;
  readonly loading: boolean;
  refresh(): void;
}

export function useAriaList(o: ListOptions = {}): AriaListState {
  const client = useAriaClient();
  const [rev, setRev] = useState(0);
  const [state, setState] = useState<{ list: AriaList | undefined; error: unknown; loading: boolean }>({ list: undefined, error: undefined, loading: true });
  const key = JSON.stringify(o);
  const connection = useAriaConnection();
  useEffect(() => {
    if (connection !== "open") return;
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    client.list(o).then(
      (list) => live && setState({ list, error: undefined, loading: false }),
      (error: unknown) => live && setState((s) => ({ ...s, error, loading: false })),
    );
    return () => {
      live = false;
    };
  }, [client, key, rev, connection === "open"]);
  const refresh = useCallback(() => setRev((n) => n + 1), []);
  return { ...state, refresh };
}
