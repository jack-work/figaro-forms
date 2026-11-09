import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { FormsClient, FormRef } from "../client.js";
import type { Json, JsonObject } from "../json.js";
import type { Patch } from "../patch.js";
import type { PathLike } from "../path.js";
import type { EditResult, FormStatus, Replica } from "../replica.js";
import type { ConnectionState } from "../rpc.js";
import { flatten, type ViewNode, type OpenState } from "../view/index.js";

const Context = createContext<FormsClient | null>(null);

export function FormsProvider(props: { readonly client: FormsClient; readonly children?: ReactNode }): ReactNode {
  return createElement(Context.Provider, { value: props.client }, props.children);
}

export function useFormsClient(): FormsClient {
  const c = useContext(Context);
  if (!c) throw new Error("useFormsClient: no FormsProvider above this component");
  return c;
}

const refKey = (ref: string | FormRef): string => (typeof ref === "string" ? ref : `${ref.id}/${ref.intrinsic ?? "state"}`);

export function useReplica(ref: string | FormRef): Replica {
  const client = useFormsClient();
  const key = refKey(ref);
  const replica = useMemo(() => client.peek(ref), [client, key]);
  useEffect(() => {
    client.retain(ref);
    return () => client.release(ref);
  }, [client, key]);
  return replica;
}

export function useFormValue(ref: string | FormRef, path: PathLike): Json | undefined {
  const r = useReplica(ref);
  const pathKey = typeof path === "string" ? path : JSON.stringify(path);
  const subscribe = useCallback((fn: () => void) => r.subscribe(path, fn), [r, pathKey]);
  const get = useCallback(() => r.get(path), [r, pathKey]);
  return useSyncExternalStore(subscribe, get, get);
}

export function useForm(ref: string | FormRef): JsonObject {
  const r = useReplica(ref);
  const subscribe = useCallback((fn: () => void) => r.subscribe([], fn), [r]);
  const get = useCallback(() => r.root, [r]);
  return useSyncExternalStore(subscribe, get, get);
}

export function useFormStatus(ref: string | FormRef): FormStatus {
  const r = useReplica(ref);
  const subscribe = useCallback((fn: () => void) => r.onStatus(fn), [r]);
  const get = useCallback(() => r.status, [r]);
  return useSyncExternalStore(subscribe, get, get);
}

export interface FormEditor {
  set(path: PathLike, value: Json): Promise<EditResult>;
  unset(path: PathLike): Promise<EditResult>;
  edit(p: Patch): Promise<EditResult>;
}

export function useFormEditor(ref: string | FormRef): FormEditor {
  const r = useReplica(ref);
  return useMemo(
    () => ({
      set: (path: PathLike, value: Json) => r.set(path, value),
      unset: (path: PathLike) => r.unset(path),
      edit: (p: Patch) => r.edit(p),
    }),
    [r],
  );
}

export function useConnectionState(): ConnectionState {
  const client = useFormsClient();
  const subscribe = useCallback((fn: () => void) => client.connection.onState(fn), [client]);
  const get = useCallback(() => client.connection.state, [client]);
  return useSyncExternalStore(subscribe, get, get);
}

export function useOpenState(open: OpenState): number {
  const subscribe = useCallback((fn: () => void) => open.subscribe(fn), [open]);
  const get = useCallback(() => open.version, [open]);
  return useSyncExternalStore(subscribe, get, get);
}

export interface UseFormViewOptions {
  readonly open: OpenState;
  readonly subject?: string | FormRef;
  readonly overlay?: boolean;
}

export function useFormView(ref: string | FormRef, o: UseFormViewOptions): ViewNode[] {
  const root = useForm(ref);
  const status = useFormStatus(ref);
  const rev = useOpenState(o.open);
  const overlayId = status.view?.overlay?.form;
  const overlay = useOptionalForm(o.overlay === false ? undefined : overlayId);
  const subject = useOptionalForm(o.subject);
  return useMemo(
    () => flatten(root, { view: status.view, isOpen: o.open.isOpen, subject, overlay }),
    [root, status.view, rev, o.open, subject, overlay],
  );
}

const empty: JsonObject = Object.freeze({});
const noop = (): (() => void) => () => {};

function useOptionalForm(ref: string | FormRef | undefined): JsonObject | undefined {
  const client = useFormsClient();
  const key = ref === undefined ? "" : refKey(ref);
  const replica = useMemo(() => (ref === undefined ? undefined : client.peek(ref)), [client, key]);
  useEffect(() => {
    if (ref === undefined) return;
    client.retain(ref);
    return () => client.release(ref);
  }, [client, key]);
  const subscribe = useCallback((fn: () => void) => (replica ? replica.subscribe([], fn) : noop()), [replica]);
  const get = useCallback(() => (replica ? replica.root : empty), [replica]);
  const v = useSyncExternalStore(subscribe, get, get);
  return replica ? v : undefined;
}
