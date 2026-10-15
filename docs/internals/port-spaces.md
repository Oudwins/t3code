# Port spaces

> For maintainers. Using T3 Code? See [docs/user](../user/).

A port space is one Linux network namespace per thread, so several threads can run a dev server on
the same port. It isolates TCP and UDP ports only. Files, processes, and unix sockets are shared.
Linux only; a macOS client reaches one through a remote Linux environment.

[`PortSpaces`](../../apps/server/src/portSpace/PortSpaces.ts) is the interface. Callers never see the
mechanism, so a rootless backend can replace the root helper without touching them.

## Why a root helper

Creating a named namespace needs root, and unprivileged user namespaces are off by default on
current Ubuntu. `t3 portspace setup` installs
[`t3-portspace`](../../apps/server/src/portSpace/PortSpaceHelper.ts) and a sudoers entry that lets
one uid run only that file. The helper is the whole trust boundary:

- Every argument is untrusted. Ids are `[a-z0-9-]{1,32}`; the environment id and thread id are
  hashed to fit. Namespaces are machine-global, so the environment is in the hash: a dev server
  with a copy of a thread must not reach, or release, the installed server's namespace.
- User commands run only after `setpriv` drops to `SUDO_UID`/`SUDO_GID`. Nothing the helper runs
  while privileged goes through a shell.
- The child environment and cwd travel in one variable, `T3_PORTSPACE_PROLOGUE`, that sudoers keeps
  through `env_reset`. It is `eval`ed as shell only after the drop, so it grants nothing the caller
  could not already do.
- `--pdeathsig KILL` stops an orphan outliving a killed `sudo`. `delete` is the backstop.
- The installer writes hidden temp files in their final root-owned directories, validates sudoers
  with `visudo -cf`, then renames. No file the installing user can rewrite sits between script and
  destination, and it refuses directories writable by anyone but root.

Bump `PORT_SPACE_PROTOCOL` when the helper's interface changes. An older install reports
`needs-setup`, and `t3 portspace setup` upgrades it.

## Egress

A bare namespace has no route out, and agents need the internet. Each namespace gets
[`pasta`](https://passt.top) attached from outside. Traps worth knowing:

- pasta runs as `nobody` with ambient `CAP_SYS_ADMIN`+`CAP_NET_ADMIN`. As root it refuses to join
  the namespace, and the invoking user must never hold `CAP_SYS_ADMIN`.
- `-t/-u/-T/-U none` is required. pasta's default forwards every namespace listener to the host,
  which defeats isolation.
- pasta writes no usable pid file and exits on its own when the namespace is deleted. Liveness is
  "`eth0` exists in the namespace", which is also what makes `create` idempotent.
- DNS: `ip netns exec` applies `/etc/netns/t3-<id>/resolv.conf`, which points at pasta's
  `--dns-forward` address. This works even when the host resolver is a loopback address.
- Inside, the default gateway is the host's loopback. `PortSpaces.hostAddress` returns it. Anything
  in a namespace that must reach T3 itself (its MCP endpoint) has to use that address instead of
  `127.0.0.1`.

## Cleanup

`release` kills everything in the namespace, deletes it, and removes `/etc/netns/t3-<id>`. Namespaces
live in `/run/netns` and vanish on reboot. Closing a thread's resources (archive, delete) calls it
after the terminals are closed, only on hosts where port spaces are set up.

## Reaching a thread's ports

Nothing outside a namespace can reach what runs in it, and nothing listens on the host on its
behalf: no published port, no alternate port number, no machine address to hand a browser. Two
threads that both run an app on `localhost:3000` stay distinguishable because the client picks the
namespace per request, so the same URL means each thread's own app.

- [`PortRelay`](../../apps/server/src/portSpace/PortRelay.ts) runs inside the namespace
  (`t3 portspace-relay`) and listens on a unix socket in an owner-only temp directory. A path-based
  unix socket is visible from every network namespace, which is the only reason the host can reach it.
  A connection opens with `<4|6|L> <port>`, then the relay answers one status byte before raw bytes.
  `L` means `localhost`, resolved inside the namespace, so a browser's own `localhost` rules apply
  instead of the server guessing an address family.
- [`PortGateway`](../../apps/server/src/portSpace/PortGateway.ts) keeps one relay per thread and
  `dial`s it. The status byte is what lets a caller tell a refused port from a working one before it
  commits to anything. `dial` never creates a namespace and never falls back to the host network.
  A thread without a namespace fails with `no-port-space`, which clients show as a failure in that
  thread rather than loading whatever is on their own `localhost:3000`.
- [`PortTunnelRoute`](../../apps/server/src/portSpace/PortTunnelRoute.ts) exposes `dial` at
  `/api/port-space/tunnel`: one WebSocket is one TCP connection. It rides the same authenticated
  environment transport as every other `/api` route (ticket or bearer, `terminal:operate`), so local,
  Tailscale, SSH-forwarded, and relayed environments need nothing exposed beyond T3. Only loopback
  targets exist. The dial happens before the upgrade, so failures are HTTP statuses (404, 502, 503).
  There is no half-close; either side closing ends both.

A namespace made before the server restarted is not in `PortSpaces.threads`, and `dial` only serves
namespaces this process created, so dials fail until a terminal in that thread starts again.

## Using them from T3

`enablePortSpaces` is a per-environment server setting, not per thread. When it is on,
[`ThreadPortSpace`](../../apps/server/src/portSpace/ThreadPortSpace.ts) creates the thread's
namespace on first spawn and rewrites the spawn through the helper. If the namespace cannot be made
it logs and spawns in the host network: a terminal that does not open is worse than one that shares
ports.

Spawning through the helper changes what a caller holds:

- The pty's pid is root-owned `sudo`; the user's shell is its child. The server cannot signal `sudo`
  (node-pty swallows the `EPERM`), so terminal shutdown signals the user-owned descendants instead,
  and the subprocess inspector looks one level through `sudo` to find the shell.
- Spawn failure is not detected by the shell-fallback loop: `sudo` starts fine even when the shell
  it was asked to run does not exist.
- Host-side port discovery does not see a namespace's listeners. `PortScanner` asks
  `PortSpaces.listeners` per namespace, keeps loopback-reachable ones, and probes them through
  `PortGateway` (HTTP only), tagging each with its thread. As on the host, only listeners owned by
  a T3 terminal are probed. Process names come from `/proc/<pid>/exe`: `comm` is the thread name
  and reads `MainThread` for node.

## Providers

A provider is in a port space only if the process that runs its tools is. Each adapter reads
`ThreadPortSpace` when its instance is built, which is why the live layer is provided to provider
hydration in `server.ts`. The service is a `Context.Reference`: a layer that forgets to provide it
silently leaves every provider on the host network, and the types will not tell you.

- **Claude, Pi.** The adapter spawns the agent process itself, so the spawn is rewritten per thread.
  Tools the agent runs are its children and inherit the namespace.
- **Grok, Antigravity, ACP registry agents.** `AcpSessionRuntime` takes `rewriteSpawn` and applies it
  to the agent spawn only, never to health checks or version probes. Client-side terminals the
  agent asks T3 to run (Devin) are wrapped too.
- **MCP endpoint.** T3's MCP server listens on the host's loopback. The URL handed to an agent in a
  namespace is rewritten to `hostAddress`. The in-process MCP-over-ACP bridge stays on the raw host
  endpoint because T3, not the agent, dials it.
- **Not isolated: Codex, OpenCode, OpenCode 2, Cursor.** They serve every thread from one shared
  process, so there is no per-thread process to place. Their threads keep sharing the host's ports.
  Codex needs per-thread sessions first.

## Browsing a thread's ports

The browser session does the routing, not the URL. With port spaces on, a thread's preview webview
gets its own session whose proxy sends every loopback request into that thread's namespace, so an
unchanged `http://localhost:3000` page, its absolute `localhost:4000` API calls, and its WebSockets
all stay in the namespace the preview was opened from. Navigation never rewrites a URL.

Only tabs the desktop app draws in its own `<webview>` are routed: a remote environment's tabs,
which open there by default, and the tabs of the desktop's own server. Tabs that run in the
environment's server browser (web, mobile, or a desktop tab moved to the environment) are not: that
browser runs on the host, so its `localhost` is the host's, not the thread's.

- [`PortSpaceProxy`](../../apps/desktop/src/preview/PortSpaceProxy.ts) runs one loopback SOCKS5
  listener per environment and thread in desktop main, attached with `session.setProxy` to a
  per-thread partition (`getPreviewConfig` with `portSpaceThreadId`). `localhost`, `127.0.0.1`, and
  `::1` open a WebSocket to the tunnel route; every other host connects directly; loopback forms the
  tunnel cannot express (`127.0.0.2`, `0.0.0.0`) are refused rather than sent to the client's own
  machine. A host sent as a name is parsed as a URL host first, so `127.1`, `2130706433`, and
  `0x7f.0.0.1` route like the addresses they are, and anything that is not a bare host is refused.
  Tunnel sockets are `ws` duplex streams so each direction waits on its reader. Chromium reports every proxy failure as `ERR_SOCKS_CONNECTION_FAILED`, which the
  unreachable view words as a failure of that thread's port space.
- The tunnel needs a credential main cannot mint: relay environments sign with a key that lives in
  the renderer. The renderer mints a short-lived WebSocket ticket and hands it to main
  (`setPortSpaceTunnel`), renewing it every four minutes while a preview is mounted and retrying a
  failed attempt within seconds so the gap after the old ticket expires stays short. The webview
  waits for the first attempt to settle, and loopback requests fail closed whenever main holds no
  ticket.
- Chromium has no authentication for SOCKS5, so the listener accepts any local process. While a
  ticket is held, such a process can open tunnels into that thread's namespace as the signed-in user.
- The partition is ephemeral. It is keyed by thread so two threads never share cookies or storage for
  the same `localhost:3000`, which is also why it does not keep sign-ins across restarts and is not
  touched by clearing a browser profile's cookies.
- Discovery tags namespace servers with `portSpace.threadId` and clients list only their own
  thread's. Address-bar input is not special: the same `localhost` rules apply to what is typed.

If the helper is missing, terminals fall back to the host network (see above) while the preview
proxy has no namespace to dial and reports the failure in that thread. It does not browse the host.

Clients learn whether the helper is usable from `server.getPortSpacesStatus`, a unary RPC. It is not
part of the config snapshot, which is cached and compat-gated: the answer changes when the user runs
`t3 portspace setup` in a terminal, so every look re-checks.

A namespace outlives the server by design: it is released when its thread is archived or deleted,
and recreated lazily when the thread runs again. A thread deleted while the server was down leaves
its namespace behind until reboot. There is no startup sweep because the helper is per machine, and
a dev server and an installed one can share it. Nothing in a namespace can be running by then, since
every process is `--pdeathsig KILL`.
