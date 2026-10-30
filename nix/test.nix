{ pkgs, self }:

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
    services.t3code = {
      enable = true;
      user = "alice";
    };
    virtualisation.memorySize = 1536;
  };

  testScript = ''
    start_all()
    machine.wait_for_unit("user@1000.service")
    machine.wait_for_unit("t3code-host.service", user="alice")
    machine.wait_for_open_port(3773)
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
