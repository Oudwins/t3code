{
  lib,
  stdenv,
  fetchurl,
  autoPatchelfHook,
  makeWrapper,
  libsecret,
}:

let
  releases = {
    x86_64-linux = {
      arch = "x64";
      hash = "sha256-JNQmPU/UoKVlDoxwxH5JIahachAvKzO4qLxUplDkhSM=";
    };
    aarch64-linux = {
      arch = "arm64";
      hash = "sha256-V00YIwghJ/bSeEc714MwyYytPLVo0XNkKfS/pzKqQ7I=";
    };
  };
  release = releases.${stdenv.hostPlatform.system};
in
stdenv.mkDerivation rec {
  pname = "t3code";
  version = "0.1.15";

  src = fetchurl {
    url = "https://github.com/Oudwins/t3code/releases/download/v${version}/t3-${version}-linux-${release.arch}.tar.gz";
    inherit (release) hash;
  };

  nativeBuildInputs = [
    autoPatchelfHook
    makeWrapper
  ];
  buildInputs = [
    stdenv.cc.cc.lib
    libsecret
  ];
  dontBuild = true;
  # Node's single-executable payload must survive the fixup phase.
  dontStrip = true;

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/lib/t3code" "$out/bin"
    cp -a . "$out/lib/t3code/"
    makeWrapper "$out/lib/t3code/t3" "$out/bin/t3" \
      --prefix PATH : /run/wrappers/bin
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    export HOME="$TMPDIR/home"
    mkdir -p "$HOME"
    "$out/bin/t3" --version | grep -F "t3 v${version}"
    runHook postInstallCheck
  '';

  meta = {
    description = "T3 Code native CLI and host backend";
    homepage = "https://github.com/Oudwins/t3code";
    license = lib.licenses.mit;
    platforms = builtins.attrNames releases;
    mainProgram = "t3";
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}
