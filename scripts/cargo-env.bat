@echo off
rem cargo check / test helper: load the MSVC environment (vcvars64) first,
rem then run cargo under src-tauri.
rem
rem Fixes "failed to find tool cl.exe" when running cargo from Git Bash
rem (C dependencies like ring / aws-lc-sys / libsqlite3-sys need MSVC).
rem
rem NOTE: keep this file ASCII-only. cmd parses .bat in the OEM codepage;
rem UTF-8 Chinese comments break the parser (stray fragments get executed).
rem
rem vcvars64.bat path comes from the STARHUB_VCVARS user env var (setx once
rem on a new machine); falls back to the local default under D:\c++1.
rem
rem Usage:
rem   scripts\cargo-env.bat check
rem   scripts\cargo-env.bat test
rem   scripts\cargo-env.bat build --release

if "%STARHUB_VCVARS%"=="" set "STARHUB_VCVARS=D:\c++1\VC\Auxiliary\Build\vcvars64.bat"
call "%STARHUB_VCVARS%" >nul 2>&1
rem vcvars may reset PATH and drop cargo; ensure the rust toolchain bin is on
rem PATH. Prefer the rustup proxy dir (Cargo home bin) when present, else fall
rem back to the active toolchain's own bin (cargo/rustc live there too).
if not exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
  if exist "%USERPROFILE%\.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin\cargo.exe" (
    set "PATH=%USERPROFILE%\.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin;%PATH%"
  )
)
cd /d "%~dp0..\src-tauri"
cargo %*
