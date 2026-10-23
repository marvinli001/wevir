# Install the Wevir command-line client on Windows (x64). The package carries its own Node, so neither Node nor the
# desktop app is needed. Run it again to update.
#
#   irm https://dl.edgeweir.com/cli/install.ps1 | iex
#
# Environment variables:
#   WEVIR_CLI_CHANNEL  stable or beta. Default stable; beta until the first stable release
#   WEVIR_CLI_VERSION  install this version instead of the channel's newest
#   WEVIR_CLI_PREFIX   where versions are kept. Default %LOCALAPPDATA%\Programs\wevir-cli
#   WEVIR_CLI_MIRROR   download only from this address (a directory laid out like https://dl.edgeweir.com/cli)
#
# Each package is checked against the sha256 in the release's checksums file before it is unpacked.
# Layout: <prefix>\<version>\ (bin\wevir.cmd, lib\), <prefix>\bin\wevir.cmd calls the current version and is on the user
# PATH. The previous version stays until the next install, so a Host started from it keeps running.
# Uninstall: delete <prefix> and remove <prefix>\bin from the user PATH (data stays in %APPDATA%\Wevir).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Install-WevirCli {
  $lines = @(
    'https://dl.edgeweir.com/cli',
    'https://github.com/marvinli001/wevir/releases/download/cli',
    'https://download.wevir.si/cli'
  )
  if ($env:WEVIR_CLI_MIRROR) { $lines = @($env:WEVIR_CLI_MIRROR.TrimEnd('/')) }
  $channel = $env:WEVIR_CLI_CHANNEL
  if ($channel -and $channel -notin @('stable', 'beta')) { throw "WEVIR_CLI_CHANNEL is stable or beta, not $channel" }
  $prefix = $env:WEVIR_CLI_PREFIX
  if (-not $prefix) { $prefix = Join-Path $env:LOCALAPPDATA 'Programs\wevir-cli' }

  # x64 only; Windows on Arm runs it under emulation.
  $arch = $env:PROCESSOR_ARCHITEW6432
  if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
  if ($arch -notin @('AMD64', 'ARM64')) { throw "unsupported architecture $arch (x64)" }
  $platform = 'win32-x64'
  $versionPattern = '^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$'

  $version = $env:WEVIR_CLI_VERSION
  if (-not $version) {
    $pointers = if ($channel) { @($channel) } else { @('stable', 'beta') }
    :find foreach ($pointer in $pointers) {
      $file = if ($pointer -eq 'beta') { 'beta.txt' } else { 'latest.txt' }
      foreach ($line in $lines) {
        try {
          $text = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 "$line/$file").Content
          if ($text -is [byte[]]) { $text = [Text.Encoding]::UTF8.GetString($text) }
          $candidate = $text.Trim()
          if ($candidate -match $versionPattern) { $version = $candidate; break find }
        } catch {}
      }
      if (-not $channel -and $pointer -eq 'stable') { Write-Host 'No stable release yet; installing the beta channel.' }
    }
    if (-not $version) { throw "could not read the newest version from $($lines -join ', ')" }
  }
  if ($version -notmatch $versionPattern) { throw "not a version: $version" }

  $name = "wevir-cli-$version-$platform"
  $archive = "$name.zip"
  $sums = "wevir-cli-$version-checksums.txt"
  $temp = Join-Path ([IO.Path]::GetTempPath()) "wevir-cli-$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $temp | Out-Null
  try {
    $ok = $false
    foreach ($line in $lines) {
      Write-Host "Downloading $line/$archive"
      try {
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 600 "$line/$sums" -OutFile (Join-Path $temp $sums)
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 3600 "$line/$archive" -OutFile (Join-Path $temp $archive)
      } catch {
        Write-Host "Download from $line failed: $($_.Exception.Message)"
        continue
      }
      $expected = ''
      foreach ($entry in Get-Content (Join-Path $temp $sums)) {
        $parts = $entry -split '\s+\*?', 2
        if ($parts.Count -eq 2 -and $parts[1].Trim() -eq $archive) { $expected = $parts[0].ToLowerInvariant() }
      }
      $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $temp $archive)).Hash.ToLowerInvariant()
      if ($expected -and $expected -eq $actual) { $ok = $true; break }
      Write-Host "sha256 of $archive from $line is $actual, expected $expected; trying the next line"
    }
    if (-not $ok) { throw "could not download a verified $archive" }

    New-Item -ItemType Directory -Force -Path $prefix | Out-Null
    $unpack = Join-Path $prefix ".unpack-$PID"
    if (Test-Path $unpack) { Remove-Item -Recurse -Force $unpack }
    Expand-Archive -Path (Join-Path $temp $archive) -DestinationPath $unpack
    if (-not (Test-Path (Join-Path $unpack "$name\bin\wevir.cmd"))) { throw "$archive has no $name\bin\wevir.cmd" }
    $target = Join-Path $prefix $version
    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
    Move-Item (Join-Path $unpack $name) $target
    Remove-Item -Recurse -Force $unpack
  } finally {
    Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
  }

  # The shim on PATH calls the current version; the version it pointed to before is kept.
  $binDir = Join-Path $prefix 'bin'
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  $shim = Join-Path $binDir 'wevir.cmd'
  $previous = ''
  if (Test-Path $shim) {
    $match = Select-String -Path $shim -Pattern '\.\.\\([^\\]+)\\bin\\wevir\.cmd' | Select-Object -First 1
    if ($match) { $previous = $match.Matches[0].Groups[1].Value }
  }
  $shimText = "@echo off`r`ncall `"%~dp0..\$version\bin\wevir.cmd`" %*`r`nexit /b %ERRORLEVEL%`r`n"
  [IO.File]::WriteAllText($shim, $shimText, [Text.Encoding]::ASCII)
  foreach ($dir in Get-ChildItem -Directory $prefix) {
    if ($dir.Name -match $versionPattern -and $dir.Name -ne $version -and $dir.Name -ne $previous) {
      Remove-Item -Recurse -Force $dir.FullName -ErrorAction SilentlyContinue
    }
  }

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $entries = if ($userPath) { $userPath -split ';' } else { @() }
  if ($entries -notcontains $binDir) {
    [Environment]::SetEnvironmentVariable('Path', (@($entries | Where-Object { $_ }) + $binDir) -join ';', 'User')
    Write-Host "Added $binDir to the user PATH; open a new terminal to use wevir."
  }
  if (($env:Path -split ';') -notcontains $binDir) { $env:Path = "$env:Path;$binDir" }

  Write-Host "Installed wevir $version in $prefix\$version"
  if ($previous -and $previous -ne $version) {
    Write-Host "A Host started by wevir $previous keeps running on that version; to switch: wevir host stop, then wevir host start"
  }
  Write-Host 'Next: wevir host start'
}

Install-WevirCli
