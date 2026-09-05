#!/usr/bin/env bash
# Assemble the single-file executable on Linux or macOS.
#
# Windows uses build-exe.ps1 instead (it also stamps an icon and version
# resource and can code-sign). This script exists so the whole pipeline can be
# exercised in CI on a fast Linux runner before the Windows job runs.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dist="$here/dist"
blob="$dist/sea-prep.blob"
out="$dist/open-admin"

[ -f "$blob" ] || { echo "build-bin: no sea-prep.blob - run 'npm run package' first" >&2; exit 1; }

echo "build-bin: copying the node runtime"
cp "$(command -v node)" "$out"
chmod u+w "$out"

# The signature can't survive a new section being appended, and an invalid
# signature is worse than none.
if [ "$(uname)" = "Darwin" ]; then
  codesign --remove-signature "$out" || true
fi

echo "build-bin: injecting the application blob"
if [ "$(uname)" = "Darwin" ]; then
  npx --yes postject "$out" NODE_SEA_BLOB "$blob" \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
    --macho-segment-name NODE_SEA
  codesign --sign - "$out"
else
  # postject warns about ".note" section names on Linux; harmless.
  npx --yes postject "$out" NODE_SEA_BLOB "$blob" \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
fi

chmod +x "$out"
size_mb=$(( $(wc -c < "$out") / 1024 / 1024 ))
echo "build-bin: wrote $out (${size_mb} MB)"

if command -v sha256sum > /dev/null; then
  (cd "$dist" && sha256sum "$(basename "$out")" > SHA256SUMS.txt)
elif command -v shasum > /dev/null; then
  (cd "$dist" && shasum -a 256 "$(basename "$out")" > SHA256SUMS.txt)
fi
