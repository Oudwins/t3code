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

- Every argument is untrusted. Ids are `[a-z0-9-]{1,32}`; thread ids are hashed to fit.
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
live in `/run/netns` and vanish on reboot.
