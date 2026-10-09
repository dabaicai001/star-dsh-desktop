@echo off
rem cargo helper for the drop-Tauri migration (sidecar-rust workspace).
rem
rem cargo-env.bat only knows about src-tauri and assumes %USERPROFILE%\.cargo\bin
rem holds the rustup proxy (it does not on this machine: the toolchain bin is
rem under .rustup\toolchains\...\bin). This wrapper loads MSVC, puts the
rem toolchain bin on PATH, then runs cargo with --manifest-path sidecar-rust.
rem
rem Usage:
rem   scripts\cargo-sidecar.bat check -p starhub-live -j 2
rem   scripts\cargo-sidecar.bat test -p starhub-live -j 2
rem   scripts\cargo-sidecar.bat fmt --all --manifest-path ..\sidecar-rust\Cargo.toml

if "%STARHUB_VCVARS%"=="" set "STARHUB_VCVARS=D:\c++1\VC\Auxiliary\Build\vcvars64.bat"
call "%STARHUB_VCVARS%" >nul 2>&1

set "STARHUB_TOOLCHAIN_BIN=%USERPROFILE%\.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin"
if exist "%STARHUB_TOOLCHAIN_BIN%\cargo.exe" set "PATH=%STARHUB_TOOLCHAIN_BIN%;%PATH%"
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

cargo %1 --manifest-path "%~dp0..\sidecar-rust\Cargo.toml" %2 %3 %4 %5 %6 %7 %8 %9
