{
  lib,
  runCommand,
  nodejs,
  bash,
  coreutils,
  gawk,
  iproute2,
  util-linux,
  passt,
}:

runCommand "t3-portspace"
  {
    nativeBuildInputs = [ nodejs ];
  }
  ''
    mkdir -p "$out/bin"
    protocol=$(node --input-type=module -e '
      import { writeFileSync } from "node:fs";
      import { portSpaceHelperScript, PORT_SPACE_PROTOCOL } from "${../apps/server/src/portSpace/PortSpaceHelper.ts}";
      writeFileSync(process.env.out + "/bin/t3-portspace", portSpaceHelperScript);
      console.log(PORT_SPACE_PROTOCOL);
    ')
    substituteInPlace "$out/bin/t3-portspace" \
      --replace-fail '#!/bin/sh' '#!${bash}/bin/sh' \
      --replace-fail 'PATH=/usr/sbin:/usr/bin:/sbin:/bin' 'PATH=${
        lib.makeBinPath [
          bash
          coreutils
          gawk
          iproute2
          util-linux
          passt
        ]
      }'
    chmod 0755 "$out/bin/t3-portspace"
    test "$("$out/bin/t3-portspace" version)" = "$protocol"
    test -z "$("$out/bin/t3-portspace" check)"
  ''
