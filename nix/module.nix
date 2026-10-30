self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.programs.t3code;
  helperPath = "/usr/local/libexec/t3-portspace";
  helper = self.packages.${pkgs.stdenv.hostPlatform.system}.portspace-helper;
in
{
  options.programs.t3code = {
    enable = lib.mkEnableOption "T3 Code's native desktop app and CLI";
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.t3code;
      description = "T3 Code desktop and CLI package.";
    };
    portSpaces.users = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Normal users allowed to use port spaces. A nonempty list installs the helper and its sudo rules.";
    };
  };

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      { environment.systemPackages = [ cfg.package ]; }
      (lib.mkIf (cfg.portSpaces.users != [ ]) {
        assertions = map (user: {
          assertion = config.users.users.${user}.isNormalUser;
          message = "programs.t3code.portSpaces.users must name existing normal users.";
        }) cfg.portSpaces.users;

        systemd.tmpfiles.rules = [
          "d /usr/local 0755 root root -"
          "d /usr/local/libexec 0755 root root -"
          "L+ ${helperPath} - - - - ${helper}/bin/t3-portspace"
        ];

        security.sudo = {
          enable = true;
          extraConfig = ''
            Defaults!${helperPath} !use_pty
            Defaults!${helperPath} env_keep += "T3_PORTSPACE_PROLOGUE"
          '';
          extraRules = [
            {
              users = cfg.portSpaces.users;
              commands = [
                {
                  command = helperPath;
                  options = [ "NOPASSWD" ];
                }
              ];
            }
          ];
        };
      })
    ]
  );
}
