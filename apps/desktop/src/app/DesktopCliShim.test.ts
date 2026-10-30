// @effect-diagnostics nodeBuiltinImport:off - Runs the rendered launcher in a real shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { type CliShimTarget, renderCliShim } from "./DesktopCliShim.ts";

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

const tempRoot = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cli-shim-"));
  directories.push(root);
  return root;
};

const writeExecutable = (path: string, content: string) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, content, { mode: 0o755 });
};

const writeShim = (root: string, target: CliShimTarget) => {
  const shim = NodePath.join(root, "bin", "t3");
  writeExecutable(shim, renderCliShim({ target, shimPath: shim, t3Home: `${root}/home` }));
  return shim;
};

const run = (shim: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}) =>
  NodeChildProcess.spawnSync(shim, args, {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });

const REPORTER =
  '#!/bin/sh\necho "node=$ELECTRON_RUN_AS_NODE cli=$T3CODE_CLI_PATH home=$T3CODE_HOME"\nprintf "%s\\n" "$@"\nexit 3\n';

const fakeAppImage = (mode: "mount" | "extract" | "appimage-run") => {
  const root = tempRoot();
  const image = NodePath.join(root, "image with spaces");
  const tools = NodePath.join(root, "tools");
  NodeFS.mkdirSync(tools);
  for (const tool of ["cp", "head", "mktemp", "rm", "sleep", "touch"]) {
    const executable = NodeChildProcess.execFileSync("sh", ["-c", 'command -v "$1"', "_", tool], {
      encoding: "utf8",
    }).trim();
    NodeFS.symlinkSync(executable, NodePath.join(tools, tool));
  }
  writeExecutable(NodePath.join(image, "t3code"), REPORTER);
  if (mode === "appimage-run") {
    const entry = NodePath.join(image, "resources/app.asar/apps/server/dist/bin.mjs");
    NodeFS.mkdirSync(NodePath.dirname(entry), { recursive: true });
    NodeFS.writeFileSync(
      entry,
      [
        "if (!import.meta.main) process.exit(9);",
        "console.log(`node=${process.env.ELECTRON_RUN_AS_NODE} cli=${process.env.T3CODE_CLI_PATH} home=${process.env.T3CODE_HOME}`);",
        'console.log(process.argv.slice(1).join("\\n"));',
        "process.exit(3);",
      ].join("\n"),
    );
    writeExecutable(NodePath.join(image, "AppRun"), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
    writeExecutable(
      NodePath.join(tools, "appimage-run"),
      [
        "#!/bin/sh",
        '[ "$1" = -w ] || { echo "unexpected startup text"; exit 9; }',
        'export APPDIR="$2"',
        "shift 2",
        'exec "$APPDIR/AppRun" "$@"',
        "",
      ].join("\n"),
    );
  }
  const appImage = NodePath.join(root, "T3 Code.AppImage");
  writeExecutable(
    appImage,
    [
      "#!/bin/sh",
      ...(mode === "appimage-run" ? ["echo 'bad option: --appimage-extract' >&2; exit 9"] : []),
      `if [ "$1" = --appimage-extract ]; then cp -R '${image}' squashfs-root; exit 0; fi`,
      '[ "$1" = --appimage-mount ] || exit 9',
      '[ -n "$APPIMAGE_EXTRACT_AND_RUN" ] && exit 8',
      mode === "mount" ? `echo '${image}'` : 'echo "Cannot mount AppImage"; exit 1',
      `trap 'touch "${root}/unmounted"; exit 0' TERM`,
      "while :; do sleep 0.05; done",
      "",
    ].join("\n"),
  );
  const shim = writeShim(root, {
    kind: "appimage",
    appImage,
    appDirectory: image,
    executableName: "t3code",
  });
  return { root, image, appImage, shim, tools };
};

describe("renderCliShim", () => {
  it.each(["mount", "extract", "appimage-run"] as const)("runs the AppImage CLI via %s", (mode) => {
    const { root, image, shim, tools } = fakeAppImage(mode);
    const args = ["portspace", "setup", "path with spaces", "literal '$value' $(echo unexpected)"];
    const result = run(shim, args, { PATH: tools, APPIMAGE_EXTRACT_AND_RUN: "1" });
    expect(result.status).toBe(3);
    expect(result.stdout.split("\n")[0]).toBe(`node=1 cli=${shim} home=${root}/home`);
    const lines = result.stdout.split("\n").slice(1);
    expect(lines[0]).toEqual(
      mode === "extract"
        ? expect.stringMatching(
            /squashfs-root\/resources\/app\.asar\/apps\/server\/dist\/bin\.mjs$/,
          )
        : `${image}/resources/app.asar/apps/server/dist/bin.mjs`,
    );
    expect(lines.slice(1)).toEqual([...args, ""]);
  });

  it("keeps the install's T3 home under sudo, unless one is set", () => {
    const root = tempRoot();
    writeExecutable(NodePath.join(root, "app"), REPORTER);
    const shim = writeShim(root, {
      kind: "direct",
      executable: NodePath.join(root, "app"),
      entry: "/bin.mjs",
    });
    expect(run(shim, []).stdout).toContain(`home=${root}/home`);
    expect(run(shim, [], { T3CODE_HOME: "/elsewhere" }).stdout).toContain("home=/elsewhere");
    const relative = NodeChildProcess.spawnSync("./bin/t3", [], { cwd: root, encoding: "utf8" });
    expect(relative.stdout).toContain(`cli=${shim}`);
  });

  it("runs an installed app's server directly", () => {
    const root = tempRoot();
    const executable = NodePath.join(root, "opt", "T3 Code", "t3code");
    writeExecutable(executable, REPORTER);
    const shim = writeShim(root, {
      kind: "direct",
      executable,
      entry: "/opt/T3's/app.asar/bin.mjs",
    });
    expect(run(shim, ["browser", "setup"]).stdout.split("\n").slice(1)).toEqual([
      "/opt/T3's/app.asar/bin.mjs",
      "browser",
      "setup",
      "",
    ]);
  });

  it("writes a Windows launcher that keeps cmd from reinterpreting paths", () => {
    const executable = "C:\\Apps\\R&whoami&X 100%\\!CHANNEL!\\T3 Code.exe";
    const script = renderCliShim({
      target: { kind: "windows", executable, entry: "C:\\Apps\\server.asar\\bin.mjs" },
      shimPath: "C:\\Users\\José\\.t3\\bin\\t3.cmd",
      t3Home: "C:\\Users\\José\\.t3",
    });
    const lines = script.split("\r\n");
    expect(lines).toContain("setlocal EnableExtensions DisableDelayedExpansion");
    expect(lines).toContain("chcp 65001 >nul");
    expect(lines).toContain(
      'if exist "C:\\Apps\\R&whoami&X 100%%\\!CHANNEL!\\T3 Code.exe" goto run',
    );
    const bare = lines.filter(
      (line) => line.includes("whoami") && !/"[^"]*whoami[^"]*"/.test(line),
    );
    expect(bare).toEqual([]);
    expect(lines).toContain('set "T3CODE_CLI_PATH=C:\\Users\\José\\.t3\\bin\\t3.cmd"');
  });
});
