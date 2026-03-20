{
  fetchFromGitHub,
  lib,
  openssl,
  pkg-config,
  rustPlatform,
}:

# Local override of prisma-engines to match the project's Prisma 7.5.0 dependency.
# Upstream nixpkgs only ships 7.3.0 — bump this derivation together with package.json.
rustPlatform.buildRustPackage (finalAttrs: {
  pname = "prisma-engines";
  version = "7.5.0";

  src = fetchFromGitHub {
    owner = "prisma";
    repo = "prisma-engines";
    tag = finalAttrs.version;
    hash = "sha256-1hvIgTqqCN20VQny/4rTr2d5LP0Tt9lYa8ugsIY0CqY=";
  };

  # Set to all-zeros on first build — Nix will print the correct hash.
  cargoHash = "sha256-uiFvzxwVJXCW9LUDFRC6ZkzSa7LQk+9ZJcaJw8mrBX4=";

  env.OPENSSL_NO_VENDOR = 1;

  nativeBuildInputs = [ pkg-config ];

  buildInputs = [ openssl ];

  preBuild = ''
    export OPENSSL_DIR=${lib.getDev openssl}
    export OPENSSL_LIB_DIR=${lib.getLib openssl}/lib

    export SQLITE_MAX_VARIABLE_NUMBER=250000
    export SQLITE_MAX_EXPR_DEPTH=10000

    export GIT_HASH=0000000000000000000000000000000000000000
  '';

  cargoBuildFlags = [
    "-p"
    "schema-engine-cli"
  ];

  doCheck = false;

  meta = {
    description = "Prisma engines 7.5.0 (local override)";
    homepage = "https://www.prisma.io/";
    license = lib.licenses.asl20;
    platforms = lib.platforms.unix;
  };
})
