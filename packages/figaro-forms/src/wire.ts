import type { Json, JsonObject } from "./json.js";
import type { Patch } from "./patch.js";

export const protocolVersion = 1;
export const formDeltaSchema = 2;
export const errFormUnavailable = -32041;
export const errDenied = -32020;

export const method = {
  hello: "angelus.hello",
  follow: "figaro.follow",
  form: "figaro.form",
  set: "figaro.set",
  formCreate: "form.create",
  formDelta: "form.delta",
  closed: "figaro.closed",
  doorLapsed: "door.lapsed",
} as const;

export type Capability = "qua.images" | "form.seq" | "form.access" | "form.view" | "normalize.report" | (string & {});

export interface Principal {
  readonly kind: "aria" | "user" | "node" | "sandbox" | (string & {});
  readonly id: string;
  readonly node?: string;
}

export interface HelloResponse {
  readonly version: number;
  readonly capabilities?: readonly Capability[];
  readonly node: string;
  readonly principal: Principal;
}

export interface FormRequest {
  readonly figaro_id: string;
  readonly intrinsic?: string;
  readonly since?: number;
  readonly client?: string;
}

export type KeyDenyKind = "system-managed" | "owner-held" | "box-held" | "box-unlisted" | (string & {});

export interface KeyDeny {
  readonly key: string;
  readonly exact?: boolean;
  readonly below?: boolean;
  readonly except?: readonly string[];
  readonly kind: KeyDenyKind;
  readonly reason: string;
}

export interface FormAccess {
  readonly mode: "read" | "write";
  readonly deny?: readonly KeyDeny[];
}

export interface ViewMark {
  readonly key?: string;
  readonly key_subject?: string;
  readonly equals?: string;
  readonly group_subject?: string;
  readonly row_subject?: string;
}

export interface ViewOverlay {
  readonly form: string;
  readonly key: string;
}

export interface ViewAction {
  readonly key: string;
  readonly label: string;
  readonly method?: string;
  readonly local?: "attend" | (string & {});
  readonly params?: Json;
  readonly confirm?: boolean;
  readonly target?: "" | "subject";
  readonly args?: { readonly [name: string]: "group" | "row" };
}

export interface FormView {
  readonly rows: readonly string[] | null;
  readonly row_aria?: string;
  readonly mount?: string;
  readonly open?: readonly string[];
  readonly sort?: string;
  readonly label?: string;
  readonly aside?: string;
  readonly through?: string;
  readonly skip?: string;
  readonly mark?: ViewMark;
  readonly overlay?: ViewOverlay;
  readonly actions?: readonly ViewAction[];
}

export interface VersionedPatch {
  readonly version: number;
  readonly patch: Patch;
}

export interface FormResponse {
  readonly snapshot?: JsonObject | null;
  readonly version?: number;
  readonly intrinsic?: string;
  readonly incarnation?: number;
  readonly delta?: boolean;
  readonly patches?: readonly VersionedPatch[];
  readonly last_seq?: number;
  readonly origin?: string;
  readonly access?: FormAccess;
  readonly view?: FormView;
}

export interface SetRequest {
  readonly figaro_id: string;
  readonly patch: Patch;
  readonly outfits?: readonly string[];
  readonly if_version?: number;
  readonly assert?: boolean;
  readonly client?: string;
  readonly seq?: number;
}

export type SetOutcome = "applied" | "unchanged" | "duplicate";

export interface SetResponse {
  readonly ok: boolean;
  readonly set?: readonly string[];
  readonly remove?: readonly string[];
  readonly outcome?: SetOutcome;
  readonly version?: number;
}

export interface FormDelta {
  readonly schema: number;
  readonly aria_id?: string;
  readonly figaro_id?: string;
  readonly intrinsic?: string;
  readonly incarnation?: number;
  readonly version: number;
  readonly patch: Patch;
  readonly at?: number;
  readonly origin?: string;
  readonly seq?: number;
}

export interface FormCreateResponse {
  readonly form_id: string;
  readonly version: number;
}

export interface DoorLapsed {
  readonly reason: string;
  readonly after_ms: number;
}
