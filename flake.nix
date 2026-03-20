{
  description = "reporting-tool dev shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        prisma-engines = pkgs.callPackage ./nix/prisma-engines.nix { };
      in {
        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_24
            pkgs.playwright-driver.browsers
            pkgs.nodePackages.prisma
            prisma-engines
          ];

          shellHook = ''
            export PLAYWRIGHT_BROWSERS_PATH=${pkgs.playwright-driver.browsers}
            export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
            export PRISMA_SCHEMA_ENGINE_BINARY=${prisma-engines}/bin/schema-engine
          '';
        };
      });
}
