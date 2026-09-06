# Assemble OpenAdmin-win-x64.exe: the Node runtime, an icon and version
# resource, and the injected application blob.
#
# Run from the repository root after `npm run package`:
#     npm run package:exe
#
# Order matters. Resource stamping rewrites the PE resource section, so it must
# happen before postject appends the blob section; signing, if configured, goes
# last. Native commands don't throw in Windows PowerShell, so every step checks
# $LASTEXITCODE itself: cosmetic steps warn, essential ones stop the build.
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$dist     = Join-Path $PSScriptRoot 'dist'
$blob     = Join-Path $dist 'sea-prep.blob'
$exeName  = 'OpenAdmin-win-x64.exe'
$exe      = Join-Path $dist $exeName

if (-not (Test-Path $blob)) {
  throw "No sea-prep.blob. Run 'npm run package' first."
}

$pkgPath = (Join-Path $repoRoot 'package.json') -replace '\\', '/'
$version = node -p "require('$pkgPath').version"
if ($LASTEXITCODE -ne 0 -or -not $version) { throw 'Could not read the version from package.json.' }
Write-Host "build-exe: building $exeName for version $version"

# 1. Start from the Node runtime running this script.
$nodeExe = (Get-Command node).Source
Copy-Item $nodeExe $exe -Force

# 2. Drop Node's Authenticode signature: appending a section invalidates it,
#    and Windows treats a broken signature more harshly than an absent one.
$signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe' -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | Select-Object -First 1
if ($signtool) {
  Write-Host 'build-exe: removing the runtime signature'
  & $signtool.FullName remove /s $exe | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Warning 'build-exe: signtool could not remove the signature; continuing' }
} else {
  Write-Warning 'build-exe: signtool.exe not found; leaving the existing signature in place'
}

# 3. Icon and version resource. Cosmetic: a failure here must not block a build.
$icon = Join-Path $PSScriptRoot 'assets\icon.ico'
node (Join-Path $PSScriptRoot 'stamp-exe.mjs') $exe $version $icon
if ($LASTEXITCODE -ne 0) { Write-Warning 'build-exe: could not stamp icon/version metadata; continuing without them' }

# 4. Inject the launcher + application archive. Essential.
Write-Host 'build-exe: injecting the application blob'
npx --yes postject $exe NODE_SEA_BLOB $blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
if ($LASTEXITCODE -ne 0) { throw 'build-exe: postject failed; the executable is not usable.' }

# 5. Code signing, when a signing command is configured. An unsigned build works
#    but shows a SmartScreen warning on first run. The command receives the
#    executable path as its final argument.
if ($env:WINDOWS_SIGN_COMMAND) {
  Write-Host 'build-exe: signing'
  Invoke-Expression "$env:WINDOWS_SIGN_COMMAND `"$exe`""
  if ($LASTEXITCODE -ne 0) { throw 'build-exe: signing failed.' }
}

$sizeMb = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host "build-exe: wrote $exe ($sizeMb MB)"

# One checksum file per binary, named so it can sit next to the download.
$hash = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
[System.IO.File]::WriteAllText((Join-Path $dist "$exeName.sha256"), "$hash  $exeName`n")
Write-Host "build-exe: sha256 $hash"
