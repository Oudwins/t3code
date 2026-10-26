/**
 * Root-owned helper that creates, enters, and deletes per-thread network namespaces, plus its
 * sudoers entry and install scripts. Input is untrusted: it validates ids, hands nothing to a
 * shell while privileged, and drops to `SUDO_UID` before running commands. `pasta` gives internet
 * without touching host firewall or sysctls; the gateway address is host loopback (T3's server).
 */

export const PORT_SPACE_HELPER_PATH = "/usr/local/libexec/t3-portspace";
export const PORT_SPACE_SUDOERS_PATH = "/etc/sudoers.d/t3-portspace";
export const PORT_SPACE_SETUP_COMMAND = "t3 portspace setup";

/** Bump when the helper's interface changes; `t3 portspace setup` upgrades an older install. */
export const PORT_SPACE_PROTOCOL = 2;

// Shell `${` is escaped as `\${` because this is a template literal.
export const portSpaceHelperScript = `#!/bin/sh
# t3-portspace: per-thread Linux network namespaces for T3 Code.
# Installed root-owned and run through a narrow sudoers entry. Every
# argument is untrusted: ids are validated, nothing is passed to a shell
# while privileged, and user commands run only after dropping to SUDO_UID.
set -eu
umask 022

PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

PROTOCOL=${PORT_SPACE_PROTOCOL}
# Inside a namespace this address reaches the host's resolver through pasta.
DNS_ADDR=169.254.1.53

die() {
  echo "t3-portspace: $*" >&2
  exit 2
}

valid_id() {
  case "$1" in
    "" | -* | *[!a-z0-9-]*) return 1 ;;
  esac
  [ "\${#1}" -le 32 ]
}

need_id() {
  valid_id "\${1:-}" || die "invalid port space id"
}

need_ns() {
  [ -e "/run/netns/t3-$1" ] || die "no such port space: $1"
}

# run_in_ns <id> <command> [args...]
# Enters the namespace (\`ip netns exec\`, which also applies the namespace's
# /etc/netns/<name>/resolv.conf), then runs the command as the user who
# invoked sudo. Invoked directly as root (no SUDO_UID) there is nothing to
# drop. The command is killed if its parent (sudo) dies, so force-killing the
# wrapper cannot leave an orphan behind.
run_in_ns() {
  ns=$1
  shift
  if [ -z "\${SUDO_UID:-}" ]; then
    exec ip netns exec "t3-$ns" setpriv --pdeathsig KILL -- "$@"
  fi
  case "\${SUDO_UID}:\${SUDO_GID:-}" in
    *[!0-9:]* | : | :* | *:) die "bad SUDO_UID/SUDO_GID" ;;
  esac
  [ "$SUDO_UID" != 0 ] || die "refusing to run as uid 0 through sudo"
  exec ip netns exec "t3-$ns" \\
    setpriv --reuid="$SUDO_UID" --regid="$SUDO_GID" --init-groups --pdeathsig KILL -- "$@"
}

# Prints the required tools this machine is missing, one per line.
cmd_check() {
  for tool in ip nsenter setpriv ss pasta; do
    command -v "$tool" >/dev/null 2>&1 || echo "$tool"
  done
}

# Gives a namespace internet. pasta runs as nobody with just enough
# capability to join the namespace: root cannot, and the invoking user must
# never hold CAP_SYS_ADMIN (it could ptrace its way to a root-equivalent).
# Port forwarding stays off, since pasta's default would publish every
# listener in the namespace on the host.
start_egress() {
  log=$(mktemp)
  if ! setpriv --reuid=65534 --regid=65534 --clear-groups \\
    --inh-caps=+sys_admin,+net_admin --ambient-caps=+sys_admin,+net_admin -- \\
    pasta --netns-only --netns "/run/netns/t3-$1" --config-net -I eth0 \\
    --dns-forward "$DNS_ADDR" -t none -u none -T none -U none \\
    >"$log" 2>&1 </dev/null; then
    cat "$log" >&2
    rm -f "$log"
    die "could not start pasta for $1"
  fi
  rm -f "$log"
}

# Idempotent. pasta quits when the namespace is deleted; if it died earlier
# the tap interface is gone and the next create starts it again.
cmd_create() {
  need_id "\${1:-}"
  [ -e "/run/netns/t3-$1" ] || ip netns add "t3-$1"
  ip -n "t3-$1" link set lo up
  mkdir -p "/etc/netns/t3-$1"
  echo "nameserver $DNS_ADDR" >"/etc/netns/t3-$1/resolv.conf"
  ip -n "t3-$1" link show eth0 >/dev/null 2>&1 || start_egress "$1"
}

# The namespace's default gateway: connecting to it from inside reaches the
# host's loopback, which is where T3's own server listens.
cmd_gateway() {
  need_id "\${1:-}"
  need_ns "$1"
  gw=$(ip -n "t3-$1" -4 route show default | awk '/^default/ { print $3; exit }')
  [ -n "$gw" ] || die "port space $1 has no route to the host"
  echo "$gw"
}

# exec <id> -- <command> [args...]
# T3_PORTSPACE_PROLOGUE (kept through sudo by the sudoers entry) is shell
# code that sets the environment and cwd. It is evaluated only after the
# privilege drop, so it can do nothing the caller could not already do.
cmd_exec() {
  need_id "\${1:-}"
  id=$1
  shift
  [ "\${1:-}" = "--" ] || die "usage: exec <id> -- <command> [args...]"
  shift
  [ "$#" -gt 0 ] || die "missing command"
  need_ns "$id"
  run_in_ns "$id" sh -c \\
    'p=\${T3_PORTSPACE_PROLOGUE:-}; unset T3_PORTSPACE_PROLOGUE; eval "$p"; exec "$@"' \\
    t3-portspace "$@"
}

cmd_listeners() {
  need_id "\${1:-}"
  need_ns "$1"
  exec nsenter --net="/run/netns/t3-$1" -- ss -H -tlnp
}

cmd_delete() {
  need_id "\${1:-}"
  if [ -e "/run/netns/t3-$1" ]; then
    pids=$(ip netns pids "t3-$1" 2>/dev/null || true)
    if [ -n "$pids" ]; then
      # shellcheck disable=SC2086
      kill -TERM $pids 2>/dev/null || true
      n=0
      while [ "$n" -lt 20 ]; do
        pids=$(ip netns pids "t3-$1" 2>/dev/null || true)
        [ -n "$pids" ] || break
        sleep 0.1
        n=$((n + 1))
      done
      if [ -n "$pids" ]; then
        # shellcheck disable=SC2086
        kill -KILL $pids 2>/dev/null || true
      fi
    fi
    ip netns delete "t3-$1"
  fi
  rm -rf "/etc/netns/t3-$1"
}

cmd_list() {
  [ -d /run/netns ] || exit 0
  for f in /run/netns/t3-*; do
    [ -e "$f" ] || continue
    n=\${f##*/t3-}
    if valid_id "$n"; then echo "$n"; fi
  done
}

case "\${1:-}" in
  version) echo "$PROTOCOL" ;;
  check) cmd_check ;;
  create) shift; cmd_create "$@" ;;
  exec) shift; cmd_exec "$@" ;;
  gateway) shift; cmd_gateway "$@" ;;
  listeners) shift; cmd_listeners "$@" ;;
  delete) shift; cmd_delete "$@" ;;
  list) cmd_list ;;
  *) die "usage: t3-portspace version|check|create|exec|gateway|listeners|delete|list" ;;
esac
`;

/**
 * Numeric `#uid` form so no user name ever reaches sudoers syntax.
 * `!use_pty` keeps sudo from allocating a second pty around the child, and
 * the one kept variable carries the environment the child should start with.
 */
export const portSpaceSudoersEntry = (uid: number) =>
  `# Installed by "${PORT_SPACE_SETUP_COMMAND}". Lets uid ${uid} run the T3 Code port space helper as root.
Defaults!${PORT_SPACE_HELPER_PATH} !use_pty
Defaults!${PORT_SPACE_HELPER_PATH} env_keep += "T3_PORTSPACE_PROLOGUE"
#${uid} ALL=(root) NOPASSWD: ${PORT_SPACE_HELPER_PATH}
`;

/**
 * Run as root via `sh -s` so no file the installing user could rewrite sits between the script
 * and its destination. Files are written under a hidden name in their final directory (sudo
 * ignores sudoers entries containing a dot), validated, then renamed into place. With
 * `sudoersUid` undefined the caller is already root and needs no entry.
 */
export const portSpaceInstallScript = (input: { readonly sudoersUid: number | undefined }) => {
  const sudoersUid = input.sudoersUid;
  const sudoersDir = sudoersUid === undefined ? [] : ["/etc/sudoers.d"];
  return [
    "set -eu",
    "umask 022",
    `helper=${PORT_SPACE_HELPER_PATH}`,
    `sudoers=${PORT_SPACE_SUDOERS_PATH}`,
    "dir=${helper%/*}",
    '[ -d "$dir" ] || install -d -m 0755 -o root -g root "$dir"',
    ...(sudoersUid === undefined
      ? []
      : [
          '[ -d /etc/sudoers.d ] || { echo "no /etc/sudoers.d: is sudo installed?" >&2; exit 1; }',
          'command -v visudo >/dev/null 2>&1 || { echo "visudo not found: is sudo installed?" >&2; exit 1; }',
        ]),
    `for d in /usr /usr/local "$dir" ${sudoersDir.join(" ")}; do`,
    '  if [ "$(stat -L -c %u "$d")" != 0 ] || [ -n "$(find -H "$d" -maxdepth 0 -perm /022)" ]; then',
    '    echo "refusing to install: $d is writable by someone other than root" >&2',
    "    exit 1",
    "  fi",
    "done",
    'helper_tmp=$(mktemp "$dir/.t3-portspace.XXXXXX")',
    ...(sudoersUid === undefined
      ? []
      : ["sudoers_tmp=$(mktemp /etc/sudoers.d/.t3-portspace.XXXXXX)"]),
    `trap 'rm -f "$helper_tmp"${sudoersUid === undefined ? "" : ' "$sudoers_tmp"'}' EXIT`,
    `cat >"$helper_tmp" <<'T3_PORTSPACE_HELPER_EOF'`,
    `${portSpaceHelperScript}T3_PORTSPACE_HELPER_EOF`,
    'chmod 0755 "$helper_tmp"',
    ...(sudoersUid === undefined
      ? []
      : [
          `cat >"$sudoers_tmp" <<'T3_PORTSPACE_SUDOERS_EOF'`,
          `${portSpaceSudoersEntry(sudoersUid)}T3_PORTSPACE_SUDOERS_EOF`,
          'chmod 0440 "$sudoers_tmp"',
          'visudo -cf "$sudoers_tmp" </dev/null >/dev/null',
        ]),
    'mv -f "$helper_tmp" "$helper"',
    ...(sudoersUid === undefined ? [] : ['mv -f "$sudoers_tmp" "$sudoers"']),
    "trap - EXIT",
    "",
  ].join("\n");
};

/** Deletes every port space, then the sudoers entry (closing the way in), then the helper. */
export const portSpaceRemoveScript = `set -eu
helper=${PORT_SPACE_HELPER_PATH}
if [ -x "$helper" ]; then
  for id in $("$helper" list); do
    "$helper" delete "$id" || true
  done
fi
rm -f ${PORT_SPACE_SUDOERS_PATH} "$helper"
`;
