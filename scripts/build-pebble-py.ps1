# Build the relocatable, patched pebble-tool Python bundle for the native-Windows app.
#
#   powershell -ExecutionPolicy Bypass -File scripts\build-pebble-py.ps1 [-OutDir vendor\pebble-py]
#
# Produces a self-contained, RELOCATABLE CPython (python-build-standalone) with
# pebble-tool + pypkjs + stpyv8 + pyreadline3 installed and the native-Windows
# POSIX-ism patches applied (scripts\apply-pebble-tool-patches.py). The app invokes
# it path-independently as:
#     <OutDir>\python.exe -c "from pebble_tool import run_tool; run_tool()" <args>
# (NOT pebble.exe — pip's console launcher bakes in an absolute python path.)
#
# Validated 2026-06-14: runs from an arbitrary path with no system Python on PATH.
param(
  [string]$OutDir = "vendor\pebble-py",
  [string]$PbsTag = "20260610",
  [string]$PyVer  = "3.12.13"
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$work = Join-Path $env:TEMP "pebble-py-build"
New-Item -ItemType Directory -Force $work | Out-Null

$asset = "cpython-$PyVer+$PbsTag-x86_64-pc-windows-msvc-install_only.tar.gz"
$url   = "https://github.com/astral-sh/python-build-standalone/releases/download/$PbsTag/" +
         [uri]::EscapeDataString($asset)
$tgz   = Join-Path $work "pbs.tar.gz"
Write-Host "Downloading $asset ..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $url -OutFile $tgz

$py = Join-Path $work "python"
if (Test-Path $py) { [System.IO.Directory]::Delete($py, $true) }
Write-Host "Extracting ..." -ForegroundColor Cyan
tar -xzf $tgz -C $work          # creates $work\python

$pyexe = Join-Path $py "python.exe"
Write-Host "Installing pebble-tool + pyreadline3 ..." -ForegroundColor Cyan
& $pyexe -m pip install --no-warn-script-location pebble-tool==5.0.37 pyreadline3
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }

Write-Host "Applying native-Windows patches ..." -ForegroundColor Cyan
& $pyexe (Join-Path $PSScriptRoot "apply-pebble-tool-patches.py") (Join-Path $py "Lib\site-packages")
if ($LASTEXITCODE -ne 0) { throw "patch step failed" }

Write-Host "Pruning (.pdb, __pycache__, tests) ..." -ForegroundColor Cyan
Get-ChildItem $py -Recurse -File -Filter *.pdb -EA SilentlyContinue | Remove-Item -Force -EA SilentlyContinue
Get-ChildItem $py -Recurse -Directory -Filter __pycache__ -EA SilentlyContinue | Remove-Item -Recurse -Force -EA SilentlyContinue
if (Test-Path "$py\Lib\test") { Remove-Item -Recurse -Force "$py\Lib\test" -EA SilentlyContinue }
Get-ChildItem "$py\Lib\site-packages" -Recurse -Directory -EA SilentlyContinue |
  Where-Object { $_.Name -in @('tests','test') } | Remove-Item -Recurse -Force -EA SilentlyContinue

# self-test (relocatable invocation)
$v = & $pyexe -c "from pebble_tool import run_tool; run_tool()" --version 2>&1 | Select-String "Pebble Tool"
if (-not $v) { throw "self-test failed: pebble-tool did not report a version" }
Write-Host "Self-test OK: $v" -ForegroundColor Green

$dest = Join-Path $repo $OutDir
if (Test-Path $dest) { [System.IO.Directory]::Delete($dest, $true) }
New-Item -ItemType Directory -Force (Split-Path -Parent $dest) | Out-Null
Copy-Item -Recurse -Force $py $dest
# Brand the interpreter so the emulator's Python processes (pypkjs/websockify,
# spawned via sys.executable) show as "PebbleStudioEmu.exe" in Task Manager.
# Relocatable CPython resolves its home from the directory, not the exe name.
$branded = Join-Path $dest "PebbleStudioEmu.exe"
Move-Item -Force (Join-Path $dest "python.exe") $branded
$self = & $branded -c "from pebble_tool import run_tool; run_tool()" --version 2>&1 | Select-String "Pebble Tool"
if (-not $self) { throw "branded self-test failed: pebble-tool did not report a version under PebbleStudioEmu.exe" }
Write-Host "Branded interpreter OK: $self" -ForegroundColor Green
Write-Host "Bundle ready at $dest" -ForegroundColor Green
