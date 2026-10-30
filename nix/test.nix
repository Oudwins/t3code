{ pkgs, self }:

let
  desktop = self.packages.${pkgs.stdenv.hostPlatform.system}.t3code;
in

pkgs.testers.runNixOSTest {
  name = "t3code-portspaces";

  nodes.machine = {
    imports = [ self.nixosModules.default ];
    users.users = {
      alice = {
        isNormalUser = true;
        uid = 1000;
      };
      bob.isNormalUser = true;
    };
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

  testScript = ''
    start_all()
    machine.wait_for_unit("xvfb.service")
    machine.wait_for_file("/tmp/.X11-unix/X0")
    machine.succeed("systemctl start t3code-desktop-test.service")
    machine.wait_for_unit("t3code-desktop-test.service")
    machine.wait_for_open_port(3773)
    machine.wait_until_succeeds("DISPLAY=:0 xwininfo -root -tree | grep 'T3 Code'")
    privileges = machine.succeed("runuser -u alice -- env ELECTRON_RUN_AS_NODE=1 t3code-desktop -p 'require(\"fs\").readFileSync(\"/proc/self/status\", \"utf8\")'")
    assert "NoNewPrivs:\t0" in privileges, privileges
    status = machine.succeed("runuser -u alice -- t3 portspace status")
    assert "Port spaces are ready." in status, status
    machine.fail("runuser -u bob -- sudo -n /usr/local/libexec/t3-portspace version")
    helper = "runuser -u alice -- sudo -n /usr/local/libexec/t3-portspace"
    try:
        machine.succeed(helper + " create nix-test")
        uid = machine.succeed(helper + " exec nix-test -- id -u").strip()
        assert uid == "1000", uid
        machine.succeed("ip -n t3-nix-test link show eth0")
        machine.succeed(helper + " gateway nix-test")
    finally:
        machine.succeed(helper + " delete nix-test")
    machine.fail("ip netns exec t3-nix-test true")
  '';
}
