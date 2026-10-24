# Port spaces

Port spaces give each thread its own network, so several threads and agents can run a server on the
same port. Two threads can each start a Vite dev server on `:3000` without one failing to bind or
reaching the other's. Files and processes stay shared; only ports are separate.

Port spaces need a Linux environment. On macOS, connect to a Linux machine as a remote environment
and turn them on there.

## Set up

1. On the Linux machine that runs your threads, run `t3 portspace setup`. It shows what it installs
   and asks for sudo once. The install is a small root helper plus a sudoers entry that lets only
   your user run that helper.
2. Turn on **Settings → Integrations → Port spaces** for that environment. The row says when
   something is still missing and how to fix it; choose **Check again** after you do.

`t3 portspace status` reports the same thing from a terminal, and `t3 portspace remove` takes the
helper out again.

## Use

Terminals and agents in a thread start inside its port space. Nothing about the project changes.

Servers a thread starts appear in that thread's preview tab, listed by the port they listen on. Open
`http://localhost:3000` in two threads and each preview shows that thread's own app, including the
`localhost` API and WebSocket requests the page makes. You only see your own thread's servers.

Agents have the internet, as they do outside a port space. They reach T3 Code's own tools as usual.

A thread's port space is removed when you archive or delete the thread. Turning the setting off
affects threads from their next start.

### Forward to this computer

With the desktop app, turn on **Settings → Integrations → Port spaces → Forward to this computer** to
reach the selected thread's servers at their own ports on your machine, from any browser, `curl`, or
database client. Select a thread and `http://localhost:3000` is that thread's app; select another
and refresh to get the other thread's. Every port the thread listens on is forwarded, not only web
servers. The settings row shows which ports are forwarded.

- The last T3 Code window you focused decides the thread. Switching to your browser keeps it.
- A port another app on your computer already uses is left alone and listed as in use. It is
  forwarded once that app lets it go.
- Connections open when you switch threads are closed, never moved to the other thread. Cookies and
  storage for `localhost` are shared by every thread you forward; previews keep threads apart.
- Only TCP ports from 1024 up, and only on your computer: nothing is exposed to your network.

## Good to know

- **Previews need the desktop app.** Tabs the desktop app draws itself route a thread's `localhost`
  into its port space. Tabs that run in the environment's browser, which is what the web and mobile
  apps use and what a desktop tab moved to the environment uses, are not routed yet: there
  `localhost` is the environment machine's own.
- **A preview never falls back to your machine.** If the thread's port space is missing or the
  environment is unreachable, the page reports that instead of loading whatever is on your own
  `localhost:3000`. This includes a thread whose terminals are running outside a port space because
  the setup is incomplete.
- **Previews don't keep sign-ins.** Each thread's preview session is temporary, so cookies and
  storage for a thread's `localhost` pages are gone after you restart the app.
- **Not every agent is covered.** Claude, Pi, Grok, Antigravity, and ACP agents run in a port space.
  Codex, OpenCode, and Cursor serve all threads from one shared process, so their agents keep
  sharing the machine's ports. Terminals you open in those threads are still isolated, and a preview
  only reaches servers started from them.
- **`localhost` inside a port space is the thread's own network**, not the machine's. A database or
  other service the machine runs on `127.0.0.1` is not at `localhost` for that thread.
