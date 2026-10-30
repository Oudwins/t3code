self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.t3code;
  helperPath = "/usr/local/libexec/t3-portspace";
  helper = self.packages.${pkgs.stdenv.hostPlatform.system}.portspace-helper;
  home = config.users.users.${cfg.user}.home;
in
{
  options.services.t3code = {
    enable = lib.mkEnableOption "the T3 Code host backend with port spaces";
    user = lib.mkOption {
      type = lib.types.str;
      description = "Existing normal user whose agents and projects the backend runs.";
    };
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.t3code;
      description = "Native T3 Code backend package.";
    };
    dataDir = lib.mkOption {
      type = lib.types.str;
      default = "${home}/.local/share/t3code-host";
      description = "Separate T3 home for the host backend.";
    };
    port = lib.mkOption {
      type = lib.types.port;
      default = 3773;
      description = "Loopback HTTP/WebSocket port.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.users.users.${cfg.user}.isNormalUser;
        message = "services.t3code.user must name an existing normal user.";
      }
    ];

    environment.systemPackages = [ cfg.package ];
    users.users.${cfg.user}.linger = true;

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
          users = [ cfg.user ];
          commands = [
            {
              command = helperPath;
              options = [ "NOPASSWD" ];
            }
          ];
        }
      ];
    };

    systemd.user.services.t3code-host = {
      description = "T3 Code host backend";
      wantedBy = [ "default.target" ];
      unitConfig.ConditionUser = cfg.user;
      path = [
        cfg.package
        pkgs.git
        pkgs.openssh
        "/run/wrappers"
        "${home}/.nix-profile"
        "/etc/profiles/per-user/${cfg.user}"
        "/run/current-system/sw"
        "${home}/.local"
        "${home}/.npm"
      ];
      environment.T3CODE_HOME = cfg.dataDir;
      serviceConfig = {
        ExecStart = "${lib.getExe cfg.package} serve --host 127.0.0.1 --port ${toString cfg.port}";
        Restart = "on-failure";
        RestartSec = 5;
      };
    };
  };
}
