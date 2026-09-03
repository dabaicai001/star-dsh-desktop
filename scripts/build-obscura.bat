@echo off
rem Obscura Windows compile helper: load the MSVC environment (vcvars64) first,
rem then cargo-build the obscura CLI (render feature) under vendor/obscura.
rem
rem Mirrors cargo-env.bat. Multi-line on purpose: calling vcvars64.bat inside
rem a one-line cmd /c compound swallows the "&&" tail (batch parser quirk).
rem
rem NOTE: keep this file ASCII-only. cmd parses .bat in the OEM codepage;
rem UTF-8 Chinese comments break the parser (stray fragments get executed).
rem build-obscura.mjs invokes this then copies the binary into sidecar/bin.
rem
rem render-only build: rustls transport, no CMake/Clang needed. The stealth
rem feature would require BoringSSL via CMake and is intentionally off.
rem CARGO_BUILD_JOBS=2 + CARGO_INCREMENTAL=0 follow vendor/obscura/AGENTS.md
rem (V8/deno_core dominates build memory; first build takes several minutes).

if "%STARHUB_VCVARS%"=="" set "STARHUB_VCVARS=D:\c++1\VC\Auxiliary\Build\vcvars64.bat"
rem CI windows runner 已把 MSVC 工具链放进 PATH(cargo test 直跑即可);本地开发
rem 才需要显式加载 vcvars。缺失时 call 报错被 >nul 2>&1 吞掉,依赖已有环境。
call "%STARHUB_VCVARS%" >nul 2>&1
if not exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
  if exist "%USERPROFILE%\.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin\cargo.exe" (
    set "PATH=%USERPROFILE%\.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin;%PATH%"
  )
)
set CARGO_INCREMENTAL=0
set CARGO_BUILD_JOBS=2
rem The v8 crate build script creates a gn_root symlink whenever OUT_DIR and
rem the cargo registry sit on different drives (project on D:, registry under
rem %USERPROFILE% on C:), and plain users lack the symlink privilege
rem (os error 1314). Pin CARGO_TARGET_DIR to the USERPROFILE drive so both
rem sides share one drive and the symlink is skipped entirely.
if not defined CARGO_TARGET_DIR set "CARGO_TARGET_DIR=%USERPROFILE%\.starhub\obscura-target"
cd /d "%~dp0..\vendor\obscura"
cargo build --release -p obscura-cli --bin obscura --features render
