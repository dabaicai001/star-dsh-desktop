@echo off
rem Local dev helper (not part of the product build): load MSVC env, then
rem cargo-check obscura-render with the paint feature, using the same
rem CARGO_TARGET_DIR pin as scripts/build-obscura.bat.
if "%STARHUB_VCVARS%"=="" set "STARHUB_VCVARS=D:\c++1\VC\Auxiliary\Build\vcvars64.bat"
call "%STARHUB_VCVARS%" >nul 2>&1
if not exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
  if exist "%USERPROFILE%\.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin\cargo.exe" (
    set "PATH=%USERPROFILE%\.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin;%PATH%"
  )
)
set CARGO_INCREMENTAL=0
set CARGO_BUILD_JOBS=2
if not defined CARGO_TARGET_DIR set "CARGO_TARGET_DIR=%USERPROFILE%\.starhub\obscura-target"
cd /d "%~dp0..\vendor\obscura"
cargo check -p obscura-render --features paint
