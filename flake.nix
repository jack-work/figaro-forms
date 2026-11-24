{
  description = "figaro-forms: subscribable figaro form state for TypeScript";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      version = (builtins.fromJSON (builtins.readFile ./packages/figaro-forms/package.json)).version;

      workspace = pkgs:
        let
          src = pkgs.lib.cleanSourceWith {
            src = ./.;
            filter = path: type:
              let base = baseNameOf path; in
              !(builtins.elem base [ "node_modules" "dist" ".git" "result" ]) && !(pkgs.lib.hasSuffix ".tgz" base);
          };
          versionlessLock = pkgs.runCommand "package-lock-versionless" { nativeBuildInputs = [ pkgs.jq ]; } ''
            mkdir $out
            jq '
              [.packages | to_entries[] | select(.value.link == true) | .key | ltrimstr("node_modules/")] as $ws
              | .packages |= with_entries(
                  if .key != "" and (.key | startswith("node_modules/") | not)
                  then .value |= (
                    (if has("version") then .version = "0.0.0" else . end)
                    | with_entries(
                        if (.key | IN("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"))
                        then .value |= with_entries(if (.key | IN($ws[])) then .value = "0.0.0" else . end)
                        else . end))
                  else . end)
            ' ${src}/package-lock.json > $out/package-lock.json
          '';
          fetched = pkgs.fetchNpmDeps {
            name = "figaro-forms-workspace-npm-deps";
            src = versionlessLock;
            hash = "sha256-R61bRM772SjXwnrxCaLa7OvgdBERBrDWZQplVV27k0s=";
          };
          npmDeps = pkgs.runCommand "figaro-forms-workspace-npm-deps-${version}" { } ''
            cp -r ${fetched} $out
            chmod -R u+w $out
            cp ${src}/package-lock.json $out/package-lock.json
          '';
        in
        pkgs.buildNpmPackage {
        pname = "figaro-forms-workspace";
        inherit version src npmDeps;
        nodejs = pkgs.nodejs_24;
        npmBuildScript = "build:all";
        doCheck = true;
        checkPhase = ''
          runHook preCheck
          npm run check
          npm test --workspaces --if-present
          runHook postCheck
        '';
        installPhase = ''
          runHook preInstall
          mkdir -p $out/lib $out/demo $out/tarball
          cp -r packages/figaro-forms/dist packages/figaro-forms/package.json $out/lib/
          cp -r apps/demo/dist/. $out/demo/
          export npm_config_cache=$TMPDIR/pack-cache
          (cd packages/figaro-forms && npm pack --offline --pack-destination $out/tarball)
          (cd packages/bridge && npm pack --offline --pack-destination $out/tarball)
          mkdir -p $out/bridge/lib $out/bin
          cp -r packages/bridge/dist packages/bridge/package.json $out/bridge/lib/
          cp -r node_modules/ws $out/bridge/lib/node_modules-ws
          runHook postInstall
        '';
      };
    in
    {
      packages = forAllSystems (pkgs:
        let ws = workspace pkgs; in
        {
          workspace = ws;
          default = pkgs.runCommand "figaro-forms-${version}" { } "cp -r ${ws}/lib $out";
          demo = pkgs.runCommand "figaro-forms-demo-${version}" { } "cp -r ${ws}/demo $out";
          tarball = pkgs.runCommand "figaro-forms-tarball-${version}" { } "cp -r ${ws}/tarball $out";
          bridge = pkgs.runCommand "figaro-forms-bridge-${version}" { nativeBuildInputs = [ pkgs.makeWrapper ]; } ''
            mkdir -p $out/lib/node_modules/figaro-forms $out/bin
            cp -r ${ws}/bridge/lib/dist ${ws}/bridge/lib/package.json $out/lib/
            cp -r ${ws}/bridge/lib/node_modules-ws $out/lib/node_modules/ws
            cp -r ${ws}/lib/dist ${ws}/lib/package.json $out/lib/node_modules/figaro-forms/
            makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/figaro-forms-bridge --add-flags $out/lib/dist/main.js
            makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/figaro-gateway --add-flags $out/lib/dist/gateway-main.js
          '';
        });

      checks = forAllSystems (pkgs: { workspace = self.packages.${pkgs.system}.workspace; });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell { packages = [ pkgs.nodejs_24 pkgs.go pkgs.gitleaks ]; };
      });
    };
}
