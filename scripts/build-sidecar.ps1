#!/usr/bin/env pwsh
# Build Go sidecar for current platform
# Usage: pwsh scripts/build-sidecar.ps1 [-Release]

param(
    [switch]$Release
)

$ErrorActionPreference = "Stop"

$sidecarDir = Join-Path $PSScriptRoot ".." "sidecar"
$binDir = Join-Path $sidecarDir "bin"

# Ensure bin directory exists
if (-not (Test-Path $binDir)) {
    New-Item -ItemType Directory -Path $binDir | Out-Null
}

# Respect cross-compilation targets when provided.
$targetOS = if ($env:GOOS) { $env:GOOS } elseif ($IsWindows -or $env:OS -eq "Windows_NT") { "windows" } elseif ($IsMacOS) { "darwin" } else { "linux" }
$outputName = "starhub-sidecar"
if ($targetOS -eq "windows") {
    $outputName += ".exe"
}

$outputPath = Join-Path $binDir $outputName

$targetArch = if ($env:GOARCH) { $env:GOARCH } elseif ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq "Arm64") { "arm64" } else { "amd64" }
$targetTriple = if ($env:TAURI_ENV_TARGET_TRIPLE) {
    $env:TAURI_ENV_TARGET_TRIPLE
} elseif ($targetOS -eq "windows" -and $targetArch -eq "amd64") {
    "x86_64-pc-windows-msvc"
} elseif ($targetOS -eq "windows" -and $targetArch -eq "arm64") {
    "aarch64-pc-windows-msvc"
} elseif ($targetOS -eq "darwin" -and $targetArch -eq "amd64") {
    "x86_64-apple-darwin"
} elseif ($targetOS -eq "darwin" -and $targetArch -eq "arm64") {
    "aarch64-apple-darwin"
} elseif ($targetOS -eq "linux" -and $targetArch -eq "amd64") {
    "x86_64-unknown-linux-gnu"
} elseif ($targetOS -eq "linux" -and $targetArch -eq "arm64") {
    "aarch64-unknown-linux-gnu"
} else {
    throw "Unsupported Sidecar target: $targetOS/$targetArch"
}

# Build flags
$ldflags = "-s -w"
if ($Release -and $targetOS -eq "windows") {
    $ldflags += " -H windowsgui"
}

Write-Host "Building sidecar..." -ForegroundColor Cyan
Write-Host "  Source: $sidecarDir"
Write-Host "  Output: $outputPath"

Push-Location $sidecarDir
try {
    $env:CGO_ENABLED = "0"
    & go build -ldflags $ldflags -o $outputPath .
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Go build failed with exit code $LASTEXITCODE"
        exit 1
    }
    Write-Host "Sidecar built successfully: $outputPath" -ForegroundColor Green
    $extension = if ($targetOS -eq "windows") { ".exe" } else { "" }
    $bundledPath = Join-Path $binDir "starhub-sidecar-$targetTriple$extension"
    Copy-Item $outputPath $bundledPath -Force
    Write-Host "  Target-tagged sidecar: $bundledPath" -ForegroundColor DarkGray
} finally {
    Pop-Location
}
