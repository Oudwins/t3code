{
  lib,
  stdenv,
  fetchurl,
  appimageTools,
  autoPatchelfHook,
  makeWrapper,
  wrapGAppsHook3,
  pkgs,
  cli,
}:

let
  releases = {
    x86_64-linux = {
      arch = "x86_64";
      hash = "sha256-iBimX9vnBi3bwcdOWJ2zGCvtUlRJUajBHptn3V6gZcY=";
    };
    aarch64-linux = {
      arch = "arm64";
      hash = "sha256-fgPkAJ5mbv9DDPIBxWkcvNcTAGJAf3pR7kWyx6nA9ow=";
    };
  };
  release = releases.${stdenv.hostPlatform.system};
  extracted = appimageTools.extractType2 {
    pname = "t3code";
    inherit (cli) version;
    src = fetchurl {
      url = "https://github.com/Oudwins/t3code/releases/download/v${cli.version}/T3-Code-${cli.version}-${release.arch}.AppImage";
      inherit (release) hash;
    };
  };
in
stdenv.mkDerivation {
  pname = "t3code-desktop";
  inherit (cli) version;
  src = extracted;
  nativeBuildInputs = [
    autoPatchelfHook
    makeWrapper
    wrapGAppsHook3
  ];
  buildInputs = with pkgs; [
    alsa-lib
    at-spi2-atk
    cairo
    cups
    dbus
    expat
    glib
    gtk3
    libdrm
    libgbm
    libGL
    libsecret
    libxkbcommon
    nspr
    nss
    pango
    libx11
    libxcb
    libxcomposite
    libxdamage
    libxext
    libxfixes
    libxrandr
    systemd
    vulkan-loader
    gsettings-desktop-schemas
    stdenv.cc.cc.lib
  ];
  runtimeDependencies = map lib.getLib [
    pkgs.libGL
    pkgs.vulkan-loader
  ];
  dontBuild = true;
  dontStrip = true;
  dontWrapGApps = true;

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/lib/t3code" "$out/bin" "$out/share/applications" "$out/share/pixmaps"
    cp -a . "$out/lib/t3code/"
    ln -s ${cli}/bin/t3 "$out/bin/t3"
    install -m 0444 t3code.png "$out/share/pixmaps/t3code.png"
    sed -e "s|^Exec=.*|Exec=$out/bin/t3code-desktop %U|" \
        -e '/^X-AppImage-Version=/d' t3code.desktop > "$out/share/applications/t3code.desktop"
    runHook postInstall
  '';

  preFixup = ''
    # Keep the optional musl addons out of the launcher's glibc link flags.
    addAutoPatchelfSearchPath "${pkgs.musl}/lib"
    makeWrapper "$out/lib/t3code/t3code" "$out/bin/t3code-desktop" \
      "''${gappsWrapperArgs[@]}" \
      --unset APPIMAGE --unset APPDIR \
      --set T3CODE_DISABLE_AUTO_UPDATE true \
      --prefix PATH : /run/wrappers/bin
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    export HOME="$TMPDIR/home"
    mkdir -p "$HOME"
    ELECTRON_RUN_AS_NODE=1 "$out/bin/t3code-desktop" \
      "$out/lib/t3code/resources/app.asar/apps/server/dist/bin.mjs" --version \
      | grep -F "t3 v${cli.version}"
    runHook postInstallCheck
  '';

  meta = cli.meta // {
    description = "T3 Code native desktop app and CLI";
    mainProgram = "t3code-desktop";
  };
}
