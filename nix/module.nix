self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.programs.t3code;
  server = config.services.t3code;
  serverHome = config.users.users.${server.user}.home;
  portSpaceUsers = lib.unique (
    lib.optionals cfg.enable cfg.portSpaces.users
    ++ lib.optional (server.enable && server.portSpaces.enable) server.user
  );
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

  options.services.t3code = {
    enable = lib.mkEnableOption "the headless T3 Code server";
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.t3code-cli;
      description = "T3 Code CLI/backend package, without the desktop app.";
    };
    user = lib.mkOption {
      type = lib.types.str;
      description = "Existing normal user whose projects and provider credentials the server uses.";
    };
    dataDir = lib.mkOption {
      type = lib.types.str;
      default = "${serverHome}/.local/share/t3code-server";
      description = "T3 home for the server, separate from the desktop's default home.";
    };
    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Address on which to listen for HTTP and WebSocket connections.";
    };
    port = lib.mkOption {
      type = lib.types.port;
      default = 3773;
      description = "HTTP/WebSocket port.";
    };
    openFirewall = lib.mkEnableOption "firewall access to the T3 Code port";
    portSpaces.enable = lib.mkEnableOption "port spaces for the server user";
  };

  config = lib.mkMerge [
    {
      environment.systemPackages =
        lib.optional cfg.enable cfg.package ++ lib.optional (server.enable && !cfg.enable) server.package;
    }
    (lib.mkIf server.enable {
      assertions = [
        {
          assertion = config.users.users.${server.user}.isNormalUser;
          message = "services.t3code.user must name an existing normal user.";
        }
      ];
      networking.firewall.allowedTCPPorts = lib.optional server.openFirewall server.port;
      systemd.services.t3code = {
        description = "T3 Code server";
        wantedBy = [ "multi-user.target" ];
        after = [ "network.target" ];
        environment.T3CODE_HOME = server.dataDir;
        path = [
          server.package
          pkgs.git
          pkgs.openssh
          "/run/wrappers"
          "${serverHome}/.nix-profile"
          "/etc/profiles/per-user/${server.user}"
          "/run/current-system/sw"
          "${serverHome}/.local"
          "${serverHome}/.npm"
        ];
        serviceConfig = {
          User = server.user;
          WorkingDirectory = serverHome;
          ExecStart = lib.escapeShellArgs [
            (lib.getExe server.package)
            "serve"
            "--host"
            server.host
            "--port"
            (toString server.port)
          ];
          NoNewPrivileges = false;
          Restart = "on-failure";
          RestartSec = 5;
        };
      };
    })
    (lib.mkIf (portSpaceUsers != [ ]) {
      assertions = map (user: {
        assertion = config.users.users.${user}.isNormalUser;
        message = "T3 Code port-space users must name existing normal users.";
      }) portSpaceUsers;

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
            users = portSpaceUsers;
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
  ];
}
