<h1 align="center">figaro-forms</h1>

<p align="center">
  <a href="https://github.com/jack-work/figaro-forms/tags"><img src="https://img.shields.io/github/v/tag/jack-work/figaro-forms?color=98BB6C&labelColor=1F1F28&label=release" alt="latest release"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-NON--AI%20MPL--2.0-7E9CD8?labelColor=1F1F28" alt="license: NON-AI MPL-2.0"></a>
  <img src="https://img.shields.io/badge/typescript-ESM-7FB4CA?labelColor=1F1F28" alt="TypeScript, ESM">
  <img src="https://img.shields.io/badge/nix-flake-957FB8?labelColor=1F1F28" alt="nix flake">
</p>

<p align="center"><b>Live, subscribable <a href="https://github.com/jack-work/figaro">figaro</a> forms in TypeScript.</b><br>
Connect to a figaro daemon's door, follow any form, read and write it by path. React and jotai bindings included.</p>

State and interfaces only: no
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
  the daemon's unix socket, so the page acts as the bridge's user: the
  owner. Read-only unless started with `--write`, and `--write` still
  refuses `system.*`, daemon-written keys and outfits unless
  `--write-system` is also given. Every connection needs the token it
  prints once on stdout; never pipe that into a log or journal others can
  read. Other origins are refused unless named with `--origin`, which
  grants every page on that origin the same reach. `--static DIR` serves a
  page on the bridge's own origin, and `bridgeDoor()` reads the token from
  that page's `#token=`.

A page served with `--static` lives under a strict CSP: no inline
`<script>` or `<style>`, no `eval` or `new Function`, no frames or
objects. Put script and style in files. `--frame-src ORIGIN` lets the
page frame pages from another origin; never the bridge's own, whose pages
could read the token, and never one also given to `--origin`, so framed
content never reaches the door. The bridge cannot police the page itself,
so a page that frames must: frame with `sandbox="allow-scripts"` (no
`allow-same-origin` unless the content needs it, never
`allow-top-navigation`), treat any `postMessage` from a frame as data
after checking `event.origin`, never turn one into a door call, and never
post the token into a frame. Test drivers that evaluate code in the page
(Playwright's `wait_for_function`) are blocked by the same policy; wait
on selectors instead.

```sh
npx figaro-forms-bridge --static apps/demo/dist        # prints the page URL
npx figaro-forms-bridge --origin http://127.0.0.1:8765  # for a page served elsewhere
```

## Install

```sh
npm i "$(nix build --print-out-paths github:jack-work/figaro-forms/v0.1.2#tarball)"/figaro-forms-*.tgz
```

- Nix flake: `github:jack-work/figaro-forms/v0.1.2` gives `packages.default`
  (dist), `packages.tarball` (npm pack output), `packages.demo` (static
  demo) and `packages.bridge`.
- npm: install the tarball (`npm i <out>/figaro-forms-*.tgz`), or build
  from a clone (`npm ci && npm run build`, then `npm i <clone>/packages/figaro-forms`).
  The bridge tarball depends on figaro-forms, so install both in one `npm i`.

## Development

```sh
npm ci && npm run build && npm run check && npm test
npm run vectors      # regenerate patch vectors and the key catalog from figaro's Go api/form
```

`FIGARO_FORMS_LIVE_RUNTIME=<dev runtime dir> FIGARO_FORMS_LIVE_FORM=@id npm test`
also runs the live tests against a dev daemon with a `[door.web]`
(`authn = "upstream"`); `node apps/demo/e2e/demo.e2e.mjs` drives the built
demo in headless Chromium through the bridge.
