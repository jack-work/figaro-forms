import type { CommandName } from "./commands.gen.js";
import type { QueueDisposition } from "./aria/wire.js";

export type GatewayMethod =
  | "angelus.outfits"
  | "figaro.follow"
  | "figaro.form"
  | "figaro.read"
  | "figaro.qua"
  | "figaro.interrupt"
  | "figaro.queued"
  | "figaro.queue.delete"
  | "figaro.queue.update"
  | "figaro.fork"
  | "figaro.list"
  | "figaro.create"
  | "figaro.set";

export type WebRoute =
  | { readonly on: "gateway"; readonly methods: readonly GatewayMethod[]; readonly form?: string; readonly limits?: string }
  | { readonly on: "page"; readonly does: string }
  | { readonly on: "nowhere"; readonly reason: string };

const viaGateway = (methods: readonly GatewayMethod[], extra: { form?: string; limits?: string } = {}): WebRoute => ({ on: "gateway", methods, ...extra });
const page = (does: string): WebRoute => ({ on: "page", does });
const nowhere = (reason: string): WebRoute => ({ on: "nowhere", reason });

const delegated = "the delegated connection refuses it: a caller acting for a user may read, listen, send, fork, mint a top-level figaro and set plain keys, nothing more";
const gatewayLacks = (what: string): string => `the gateway passes no method that ${what}`;
const hostOnly = (what: string): string => `${what} on the daemon's host, which the browser does not reach`;
const noShell = "it moves a shell's attendance, and the web attends no shell";

export const webCommands: { readonly [name in CommandName]: WebRoute } = {
  help: page("lists commandDocs"),
  show: viaGateway(["figaro.read"]),
  read: viaGateway(["figaro.read"]),
  send: viaGateway(["figaro.qua"], { limits: "text only: the gateway strips a form patch, outfit or context (-O, -S, -D refused)" }),
  new: viaGateway(["figaro.create", "figaro.follow"], { limits: "-O names declared outfits only; -S, -D and a working directory are refused" }),
  listen: viaGateway(["figaro.follow"]),
  attend: viaGateway(["figaro.follow"], { limits: "shows the aria; binds no shell, so :<turn> fork points are not kept" }),
  fork: viaGateway(["figaro.fork", "figaro.follow", "figaro.qua"], { limits: "at a turn or node only; -O, -S and -D are refused (the gateway passes no patch or outfit), --stay means do not follow, and a prompt goes as a following figaro.qua" }),
  hup: viaGateway(["figaro.interrupt"], { limits: "queue: keep; -d sends queue: clear, as :cut (see hangupQueue)" }),
  cut: viaGateway(["figaro.interrupt"], { limits: "queue: clear (see hangupQueue)" }),
  queue: viaGateway(["figaro.queued", "figaro.queue.delete", "figaro.queue.update"]),
  list: viaGateway(["figaro.form"], { form: "@troupe" }),
  lsh: viaGateway(["figaro.form"], { form: "@troupe" }),
  recent: viaGateway(["figaro.form"], { form: "@recent" }),
  models: viaGateway(["figaro.form"], { form: "@models" }),
  reaped: viaGateway(["figaro.form"], { form: "@reaped", limits: "the list only; restore and purge are refused (" + delegated + ")" }),
  troupe: viaGateway(["figaro.form"], { form: "@troupe", limits: "the bare view only; login, join, leave and the root's verbs are refused (" + delegated + ")" }),
  state: viaGateway(["figaro.form", "figaro.set"], { limits: "show, listen, set, delete and unset; new, fork, rm, outfit and apply are refused (form.create is not passed, and " + delegated + ")" }),
  set: viaGateway(["figaro.set"], { limits: "plain keys: no system.*, runtime.*, name, aria_id or owner-held key, at most 32 keys and 64 KiB a value" }),
  unset: viaGateway(["figaro.set"], { limits: "plain keys, as :set" }),
  toggle: viaGateway(["figaro.form", "figaro.set"], { limits: "plain keys, as :set" }),
  get: viaGateway(["figaro.form"]),
  pwd: viaGateway(["figaro.form"]),
  status: viaGateway(["figaro.list"]),
  name: viaGateway(["figaro.list"]),
  comment: viaGateway(["figaro.form", "figaro.set"], { limits: "writes comments.<id> and its thread, plain keys as :set" }),
  notifications: page("shows what the page itself was told and what failed"),
  back: nowhere(noShell),
  forward: nowhere(noShell),
  history: nowhere(noShell),
  cd: nowhere(`it writes the working directory, a daemon-held key: ${delegated}`),
  kill: nowhere(`kill: ${delegated}`),
  succeed: nowhere(`succession forks with a seat and abdication: ${delegated}`),
  retire: nowhere(`retiring writes system.* keys: ${delegated}`),
  promote: nowhere(`moving an aria in the tree: ${delegated}`),
  demote: nowhere(`moving an aria in the tree: ${delegated}`),
  place: nowhere(`moving an aria in the tree: ${delegated}`),
  adopt: nowhere(`moving an aria in the tree: ${delegated}`),
  move: nowhere(`moving an aria between nodes: ${delegated}`),
  study: nowhere(`studies write the bound form's study keys: ${delegated}`),
  drop: nowhere(`studies write the bound form's study keys: ${delegated}`),
  cast: nowhere(`seating writes a role's target: ${delegated}`),
  bind: nowhere(`binding dresses a form in outfits: ${delegated}`),
  reroute: nowhere(`rerouting dresses a form in outfits: ${delegated}`),
  outfit: nowhere(`outfit reload: ${delegated}`),
  decide: nowhere(gatewayLacks("asks for a decision")),
  note: nowhere(gatewayLacks("leaves a note on an aria")),
  scopes: nowhere(gatewayLacks("lists an aria's grants")),
  import: nowhere(hostOnly("it reads a file")),
  export: nowhere(hostOnly("it writes a file")),
  replay: nowhere(hostOnly("it plays a tape file")),
  login: nowhere(hostOnly("provider credentials live")),
  provider: nowhere(hostOnly("provider credentials live")),
  vault: nowhere(hostOnly("the vault lives")),
  setup: nowhere(hostOnly("it configures figaro")),
  keys: nowhere("it edits the pager's own keys.toml, a terminal client's file"),
  sort: nowhere("it orders a terminal pager's form pit, a view the web does not have"),
  completion: nowhere("it prints shell completion scripts"),
  update: nowhere(hostOnly("it checks the installed binary")),
  upgrade: nowhere(hostOnly("it swaps the daemon's binary")),
  version: nowhere(hostOnly("it reports the installed binary")),
  serve: nowhere(hostOnly("it runs the daemon")),
  stop: nowhere(hostOnly("it stops the daemon")),
  gc: nowhere(`garbage collection kills arias: ${delegated}`),
  doctor: nowhere(hostOnly("it inspects the daemon")),
  normalize: nowhere(hostOnly("it rewrites the store")),
  outfits: page("shows the outfit grammar"),
  box: nowhere(hostOnly("it serves a sandbox")),
  valet: nowhere(hostOnly("it runs tools as the owner")),
};

const dropsQueue = (arg: string): boolean => arg === "--drop-queued-messages" || /^-[a-z]*d[a-z]*$/.test(arg);

export function hangupQueue(command: "hup" | "cut", args: readonly string[]): QueueDisposition {
  if (command === "cut") return "clear";
  for (const a of args) {
    if (a === "--") break;
    if (dropsQueue(a)) return "clear";
  }
  return "keep";
}
