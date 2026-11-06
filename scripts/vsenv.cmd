@echo off
setlocal
rem ============================================================
rem Mochi Windows build env wrapper (MSVC x64)
rem
rem Why: rustc on this machine does not auto-detect the MSVC
rem environment, and Git Bash's coreutils link.exe shadows the
rem MSVC one. All cargo/pnpm builds go through this wrapper.
rem
rem Usage (cmd / PowerShell / Git Bash):
rem   scripts\vsenv.cmd cargo check
rem   scripts\vsenv.cmd pnpm tauri dev
rem   scripts\vsenv.cmd pnpm tauri build
rem ============================================================

rem Optional machine-only paths; this file is ignored by Git.
rem Keep changes inside this wrapper's setlocal so the parent shell is untouched.
if exist "%~dp0vsenv.local.cmd" (
  call "%~dp0vsenv.local.cmd"
  if errorlevel 1 (
    echo [vsenv] local configuration failed - check scripts\vsenv.local.cmd
    exit /b 1
  )
)

rem Discover the installed C++ workload, rather than pinning a VS year/edition.
rem This also supports Community 2026 and future side-by-side installations.
set "MOCHI_VCVARS64="
if exist "%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" (
  for /f "usebackq delims=" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find VC\Auxiliary\Build\vcvars64.bat`) do set "MOCHI_VCVARS64=%%i"
)
rem Retain the original installation as a fallback for machines without vswhere.
if not defined MOCHI_VCVARS64 if exist "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" set "MOCHI_VCVARS64=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not defined MOCHI_VCVARS64 (
  echo [vsenv] MSVC x64 tools not found - install the Visual Studio C++ workload
  exit /b 1
)

rem Load MSVC x64 dev env (PATH / INCLUDE / LIB / LIBPATH)
call "%MOCHI_VCVARS64%" >nul
if errorlevel 1 (
  echo [vsenv] failed to load vcvars64 - check VS Build Tools install
  exit /b 1
)

rem Respect a custom CARGO_HOME (e.g. on a drive with more free space).
if defined CARGO_HOME (
  set "PATH=%CARGO_HOME%\bin;%PATH%"
) else (
  set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
)

rem Run the caller's command from the repo root
cd /d "%~dp0.."
rem CALL keeps this batch frame alive when the command is pnpm.cmd.
rem Without it, chaining to another .cmd ends this setlocal scope too early,
rem so pnpm and its cargo children lose the MSVC/Rust environment.
call %*
exit /b %errorlevel%
