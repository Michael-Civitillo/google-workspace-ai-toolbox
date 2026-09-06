# Assemble OpenAdmin-win-x64.exe: the Node runtime, an icon and version
# resource, and the injected application blob.
#
# Run from the repository root after `npm run package`:
#     npm run package:exe
#
# Written for Windows PowerShell 5.1 as well as PowerShell 7, and deliberately
# free of module-provided cmdlets: on GitHub's Windows runners this script runs
# under Windows PowerShell spawned from a pwsh step, which inherits a PowerShell
# 7 module path where 5.1's script-based cmdlets (Get-FileHash, for one) can't
# be found. Compiled cmdlets and .NET are always there, so that is all we use.
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
$icon     = Join-Path $PSScriptRoot 'assets\icon.ico'
$stamper  = Join-Path $PSScriptRoot 'stamp-exe.mjs'
$fuse     = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'

if (-not (Test-Path $blob)) {
  throw "No sea-prep.blob. Run 'npm run package' first."
}

$pkgPath = (Join-Path $repoRoot 'package.json') -replace '\\', '/'
$version = node -p "require('$pkgPath').version"
if ($LASTEXITCODE -ne 0 -or -not $version) { throw 'Could not read the version from package.json.' }

# The Windows SDK's signtool, if installed (it is on GitHub's runners).
$signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe' -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | Select-Object -First 1

function Build-Executable([bool] $Stamp) {
  # 1. Start from the Node runtime running this script.
  Copy-Item (Get-Command node).Source $exe -Force

  # 2. Drop Node's Authenticode signature: appending a section invalidates it,
  #    and Windows treats a broken signature more harshly than an absent one.
  if ($signtool) {
    Write-Host 'build-exe: removing the runtime signature'
    & $signtool.FullName remove /s $exe | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Warning 'build-exe: signtool could not remove the signature; continuing' }
  } else {
    Write-Warning 'build-exe: signtool.exe not found; leaving the existing signature in place'
  }

  # 3. Icon and version resource. Cosmetic, so a failure only warns.
  if ($Stamp) {
    node $stamper $exe $version $icon
    if ($LASTEXITCODE -ne 0) { Write-Warning 'build-exe: could not stamp icon/version metadata; continuing without them' }
  }

  # 4. Inject the launcher + application archive. Essential. postject's PE
  #    parser may print "Relocation corrupted" about the input and still
  #    inject correctly; the exit code and the start-up check below decide.
  Write-Host 'build-exe: injecting the application blob'
  npx --yes postject $exe NODE_SEA_BLOB $blob --sentinel-fuse $fuse
  if ($LASTEXITCODE -ne 0) { throw 'build-exe: postject failed; the executable is not usable.' }
}

# Does the result actually start and identify itself as the packaged build?
# `--version` exits before touching the data folder, so it is a pure check.
function Test-Executable {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'   # native stderr must not throw here
  $output = ''
  $ok = $false
  try {
    $output = (& $exe --version 2>&1 | Out-String)
    $ok = ($LASTEXITCODE -eq 0) -and ($output -match 'packaged executable\s+yes')
  } catch {
    $output = "$_"
  } finally {
    $ErrorActionPreference = $previous
  }
  if (-not $ok) { Write-Host "build-exe: start-up check output:`n$output" }
  return $ok
}

Write-Host "build-exe: building $exeName for version $version"
Build-Executable $true
if (-not (Test-Executable)) {
  Write-Warning 'build-exe: the stamped executable does not start; rebuilding without the icon and version resource'
  Build-Executable $false
  if (-not (Test-Executable)) {
    throw 'build-exe: the executable does not start even without resource stamping.'
  }
}
Write-Host 'build-exe: start-up check passed'

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
# .NET rather than Get-FileHash: see the note at the top.
$sha256 = [System.Security.Cryptography.SHA256]::Create()
$stream = [System.IO.File]::OpenRead($exe)
try {
  $digest = $sha256.ComputeHash($stream)
} finally {
  $stream.Dispose()
  $sha256.Dispose()
}
$hash = ([System.BitConverter]::ToString($digest) -replace '-', '').ToLowerInvariant()
[System.IO.File]::WriteAllText((Join-Path $dist "$exeName.sha256"), "$hash  $exeName`n")
Write-Host "build-exe: sha256 $hash"
