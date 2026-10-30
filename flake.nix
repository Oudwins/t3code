{
  description = "T3 Code host backend and NixOS port spaces";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = self.packages.${system}.t3code;
          t3code = pkgs.callPackage ./nix/package.nix { };
          portspace-helper = pkgs.callPackage ./nix/portspace-helper.nix { };
        }
      );

      nixosModules.default = import ./nix/module.nix self;

      checks = forAllSystems (system: {
        inherit (self.packages.${system}) t3code portspace-helper;
        portspaces = import ./nix/test.nix {
          pkgs = nixpkgs.legacyPackages.${system};
          inherit self;
        };
      });
    };
}
