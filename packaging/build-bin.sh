#!/usr/bin/env bash
# Assemble the single-file executable on Linux or macOS.
#
# Windows uses build-exe.ps1 instead (it also stamps an icon and version
# resource and can code-sign). Output is named by platform and CPU so the
# release can carry all of them side by side:
#   open-admin-linux-x64, open-admin-macos-arm64, ...
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dist="$here/dist"
blob="$dist/sea-prep.blob"

[ -f "$blob" ] || { echo "build-bin: no sea-prep.blob - run 'npm run package' first" >&2; exit 1; }

case "$(uname -s)" in
  Linux)  platform=linux ;;
  Darwin) platform=macos ;;
  *) echo "build-bin: unsupported OS $(uname -s) - use build-exe.ps1 on Windows" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "build-bin: unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac

name="open-admin-$platform-$arch"
out="$dist/$name"

echo "build-bin: copying the node runtime"
cp "$(command -v node)" "$out"
chmod u+w "$out"

# The runtime's signature can't survive a new section being appended, and an
# invalid signature is worse than none.
if [ "$platform" = "macos" ]; then
  codesign --remove-signature "$out" || true
fi

echo "build-bin: injecting the application blob"
if [ "$platform" = "macos" ]; then
  npx --yes postject "$out" NODE_SEA_BLOB "$blob" \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
    --macho-segment-name NODE_SEA
  # Ad-hoc signature: enough for the binary to run locally. Gatekeeper still
  # quarantines a browser download until the user allows it (see README).
  codesign --sign - "$out"
else
  # postject warns about ".note" section names on Linux; harmless.
  npx --yes postject "$out" NODE_SEA_BLOB "$blob" \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
fi

chmod +x "$out"
size_mb=$(( $(wc -c < "$out") / 1024 / 1024 ))
echo "build-bin: wrote $out (${size_mb} MB)"

# One checksum file per binary, named so it can sit next to the download.
if command -v sha256sum > /dev/null; then
  (cd "$dist" && sha256sum "$name" > "$name.sha256")
else
  (cd "$dist" && shasum -a 256 "$name" > "$name.sha256")
fi
echo "build-bin: sha256 $(cut -d' ' -f1 "$out.sha256")"
