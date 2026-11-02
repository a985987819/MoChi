@echo off
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

rem Load MSVC x64 dev env (PATH / INCLUDE / LIB / LIBPATH)
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 (
  echo [vsenv] failed to load vcvars64 - check VS Build Tools install
  exit /b 1
)

rem Make sure cargo is on PATH (rustup default location)
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

rem Run the caller's command from the repo root
cd /d "%~dp0.."
%*
