import { createContext, createElement, useCallback, useContext, useMemo, type ReactNode } from "react";
import { formKey, type FormsClient, type FormRef } from "../client.js";
import { useHeld, useStore } from "./shared.js";
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

export function useReplica(ref: string | FormRef): Replica {
  const client = useFormsClient();
  return useHeld(client, formKey(ref), () => client.peek(ref), () => client.retain(ref), () => client.release(ref)) as Replica;
}

export function useFormValue(ref: string | FormRef, path: PathLike): Json | undefined {
  const r = useReplica(ref);
  const pathKey = typeof path === "string" ? path : JSON.stringify(path);
  const subscribe = useCallback((fn: () => void) => r.subscribe(path, fn), [r, pathKey]);
  const get = useCallback(() => r.get(path), [r, pathKey]);
  return useStore(subscribe, get);
}

export function useForm(ref: string | FormRef): JsonObject {
  const r = useReplica(ref);
  const subscribe = useCallback((fn: () => void) => r.subscribe([], fn), [r]);
  const get = useCallback(() => r.root, [r]);
  return useStore(subscribe, get);
}

export function useFormStatus(ref: string | FormRef): FormStatus {
  const r = useReplica(ref);
  const subscribe = useCallback((fn: () => void) => r.onStatus(fn), [r]);
  const get = useCallback(() => r.status, [r]);
  return useStore(subscribe, get);
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
  return useStore(subscribe, get);
}

export function useOpenState(open: OpenState): number {
  const subscribe = useCallback((fn: () => void) => open.subscribe(fn), [open]);
  const get = useCallback(() => open.version, [open]);
  return useStore(subscribe, get);
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
  const replica = useHeld(
    client,
    ref === undefined ? undefined : formKey(ref),
    () => client.peek(ref as string | FormRef),
    () => client.retain(ref as string | FormRef),
    () => client.release(ref as string | FormRef),
  );
  const subscribe = useCallback((fn: () => void) => (replica ? replica.subscribe([], fn) : noop()), [replica]);
  const get = useCallback(() => (replica ? replica.root : empty), [replica]);
  const v = useStore(subscribe, get);
  return replica ? v : undefined;
}
