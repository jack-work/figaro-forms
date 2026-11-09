# figaro-forms

Subscribable figaro form state for TypeScript. State and interfaces only: no
DOM. `apps/demo` is the one place anything is drawn.

| import | holds |
|---|---|
| `figaro-forms` | `FormsClient`, `Replica` (one form: tree, status, optimistic edits), `webSocketDial`, the patch algebra, wire types |
| `figaro-forms/auth` | credentials (`edgeSession`, `bearer`, `apiKey`), `doorUrl`, `bridgeDoor`, access checks (`refusalOf`, `writable`) |
| `figaro-forms/view` | headless view model: `flatten(root, {view, isOpen, subject, overlay})`, `matchPath`, `resolveAction`, `OpenState` (UI open paths, synced across tabs over BroadcastChannel, memory only) |
| `figaro-forms/semantics` | known form ids, intrinsics, the daemon's key catalog, typed readers for runtime/queue/aria system keys |
| `figaro-forms/react` | `FormsProvider`, `useFormValue`, `useForm`, `useFormStatus`, `useFormEditor`, `useFormView`, `useConnectionState` |
| `figaro-forms/jotai` | `formValueAtom`, `formAtom`, `formStatusAtom` |

```ts
import { FormsClient, webSocketDial } from "figaro-forms";
import { doorUrl, edgeSession } from "figaro-forms/auth";

const client = new FormsClient({ dial: webSocketDial({ url: doorUrl("/door"), credential: edgeSession() }) });
const form = client.form("@619b8925...");
await form.ready();
form.subscribe("a.b", () => console.log(form.get("a.b")));
await form.set("a.b", 2);
```

A subscriber hears only changes at, above or below its path. Values are
shared structurally across versions, so an unchanged subtree keeps its
identity and a React component reading it does not re-render.

## Reaching a daemon

- Behind the edge (fig.kelliher.info): same-origin `/door`, `edgeSession()`.
  The Authelia cookie rides the upgrade.
- From Node: `bearer(token)` or `apiKey(fgk_...)` set `Authorization`.
  A browser cannot; the dial says so instead of failing quietly.
- From a local page: `figaro-forms-bridge` relays a loopback WebSocket to
  the daemon's unix socket. Read-only unless started with `--write`; every
  connection needs the token it prints; other origins are refused unless
  named with `--origin`. `--static DIR` serves a page on the bridge's own
  origin, and `bridgeDoor()` reads the token from that page's `#token=`.

```sh
npx figaro-forms-bridge --static apps/demo/dist        # prints the page URL
npx figaro-forms-bridge --origin http://127.0.0.1:8765  # for a page served elsewhere
```

## Consuming it

- Nix: input `jack/figaro-forms` on keel; `packages.default` (dist),
  `packages.tarball` (npm pack output), `packages.demo` (static demo),
  `packages.bridge`.
- npm, locally: `npm i <path>/packages/figaro-forms` after `npm run build`,
  or `npm i $(nix build --print-out-paths .#tarball)/figaro-forms-0.1.0.tgz`.

## Development

```sh
npm ci && npm run build && npm run check && npm test
npm run vectors      # regenerate patch vectors and the key catalog from figaro's Go api/form
```

`FIGARO_FORMS_LIVE_RUNTIME=<dev runtime dir> FIGARO_FORMS_LIVE_FORM=@id npm test`
also runs the live tests against a dev daemon with a `[door.web]`
(`authn = "upstream"`); `node apps/demo/e2e/demo.e2e.mjs` drives the built
demo in headless Chromium through the bridge.
