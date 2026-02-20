{
  description = "opencode-commander - Orchestrate AI coding agents across multiple repositories";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs = inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];

      perSystem = { system, ... }:
        let
          pkgs = import inputs.nixpkgs {
            inherit system;
            config.allowUnfreePredicate = pkg:
              builtins.elem (pkgs.lib.getName pkg) [
                "1password-cli"
              ];
          };
          # Podman is Linux-only in nixpkgs; on macOS use podman-desktop or brew
          linuxOnly = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [
            pkgs.podman
          ];
        in
        {
          devShells.default = pkgs.mkShell {
            packages = [
              # Node.js + Bun
              pkgs.nodejs_22
              pkgs.bun

              # Agent runtime
              pkgs.opencode

              # GitHub CLI
              pkgs.gh

              # Secrets management
              pkgs._1password-cli

              # Nix tooling (for building container images)
              pkgs.nix-prefetch-git
            ] ++ linuxOnly;

            shellHook = ''
              echo "opencode-commander dev shell"
              echo "  node: $(node --version)"
              echo "  bun:  $(bun --version)"
            '';
          };
        };
    };
}
