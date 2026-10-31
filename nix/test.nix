{ pkgs, self }:

let
  desktop = self.packages.${pkgs.stdenv.hostPlatform.system}.t3code;
in

pkgs.testers.runNixOSTest {
  name = "t3code-portspaces";

  defaults = {
    imports = [ self.nixosModules.default ];
    users.users = {
      alice = {
        isNormalUser = true;
        uid = 1000;
      };
      bob.isNormalUser = true;
    };
  };

  nodes.machine = {
    programs.t3code = {
      enable = true;
      portSpaces.users = [ "alice" ];
    };
    environment.systemPackages = [ pkgs.xwininfo ];
    systemd.services.xvfb = {
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        User = "alice";
        ExecStart = "${pkgs.xorg-server}/bin/Xvfb :0 -screen 0 1280x800x24 -nolisten tcp";
      };
    };
    systemd.services.t3code-desktop-test = {
      environment = {
        HOME = "/home/alice";
        DISPLAY = ":0";
        T3CODE_HOME = "/home/alice/t3code-test";
        T3CODE_PORT = "3773";
      };
      serviceConfig = {
        User = "alice";
        WorkingDirectory = "/home/alice";
        ExecStart = "${pkgs.lib.getExe desktop} --disable-gpu";
      };
    };
    virtualisation.memorySize = 2048;
  };

  nodes.server = {
    services.t3code = {
      enable = true;
      user = "alice";
      portSpaces.enable = true;
    };
    virtualisation.memorySize = 1024;
  };

  testScript = ''
    import json

    start_all()
    machine.wait_for_unit("xvfb.service")
    machine.wait_for_file("/tmp/.X11-unix/X0")
    machine.succeed("systemctl start t3code-desktop-test.service")
    machine.wait_for_unit("t3code-desktop-test.service")
    machine.wait_for_open_port(3773)
    machine.wait_until_succeeds("DISPLAY=:0 xwininfo -root -tree | grep 'T3 Code'")
    server.wait_for_unit("t3code.service")
    server.wait_for_open_port(3773)
    closure = server.succeed("nix-store -qR /run/current-system")
    assert "-t3code-desktop-" not in closure, closure
    assert "-electron-" not in closure, closure
    server.fail("test -e /run/current-system/sw/bin/t3code-desktop")

    for node, home in [
        (machine, "/home/alice/t3code-test"),
        (server, "/home/alice/.local/share/t3code-server"),
    ]:
        runtime_path = home + "/userdata/server-runtime.json"
        node.wait_for_file(runtime_path)
        backend_pid = json.loads(node.succeed("cat " + runtime_path))["pid"]
        privileges = node.succeed(f"cat /proc/{backend_pid}/status")
        assert "NoNewPrivs:\t0" in privileges, privileges
        status = node.succeed("runuser -u alice -- t3 portspace status")
        assert "Port spaces are ready." in status, status
        node.fail("runuser -u bob -- sudo -n /usr/local/libexec/t3-portspace version")
        helper = "runuser -u alice -- sudo -n /usr/local/libexec/t3-portspace"
        try:
            node.succeed(helper + " create nix-test")
            uid = node.succeed(helper + " exec nix-test -- id -u").strip()
            assert uid == "1000", uid
            node.succeed("ip -n t3-nix-test link show eth0")
            node.succeed(helper + " gateway nix-test")
        finally:
            node.succeed(helper + " delete nix-test")
        node.fail("ip netns exec t3-nix-test true")
  '';
}
