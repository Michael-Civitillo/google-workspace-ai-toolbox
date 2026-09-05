# Assemble OpenAdmin-win-x64.exe: the Node runtime, an icon and version
# resource, and the injected application blob.
#
# Run from the repository root after `npm run package`:
#     npm run package:exe
#
# Order matters. rcedit rewrites the PE resource section, so it must happen
# before postject appends the blob section; signing, if configured, goes last.
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$dist     = Join-Path $PSScriptRoot 'dist'
$blob     = Join-Path $dist 'sea-prep.blob'
$exeName  = 'OpenAdmin-win-x64.exe'
$exe      = Join-Path $dist $exeName

if (-not (Test-Path $blob)) {
  Write-Error "No sea-prep.blob. Run 'npm run package' first."
}

$version = (node -p "require('$($repoRoot -replace '\\','/')/package.json').version")
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
} else {
  Write-Warning 'signtool.exe not found; leaving the existing signature in place'
}

# 3. Icon and version resource. Cosmetic - a failure here must not block a build.
$icon = Join-Path $PSScriptRoot 'assets\icon.ico'
$stampScript = Join-Path $PSScriptRoot 'stamp-exe.mjs'
try {
  node $stampScript $exe $version $icon
} catch {
  Write-Warning "build-exe: could not stamp icon/version metadata: $_"
}

# 4. Inject the launcher + application archive.
Write-Host 'build-exe: injecting the application blob'
npx --yes postject $exe NODE_SEA_BLOB $blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

# 5. Code signing, when a certificate is configured. An unsigned build works
#    but shows a SmartScreen warning on first run.
if ($env:WINDOWS_SIGN_COMMAND) {
  Write-Host 'build-exe: signing'
  Invoke-Expression "$env:WINDOWS_SIGN_COMMAND `"$exe`""
}

$sizeMb = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host "build-exe: wrote $exe ($sizeMb MB)"

$hash = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
"$hash  $exeName" | Set-Content -NoNewline -Path (Join-Path $dist 'SHA256SUMS.txt')
Add-Content -Path (Join-Path $dist 'SHA256SUMS.txt') -Value ''
Write-Host "build-exe: sha256 $hash"
