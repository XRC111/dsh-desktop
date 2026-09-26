@echo off
rem ---------------------------------------------------------------------------
rem Run the multi-threaded runtime extractor with Electron's built-in Node.
rem
rem The NSIS installer calls this script (no standalone Node is available on the
rem target machine), so the app's own executable acts as the Node interpreter
rem via ELECTRON_RUN_AS_NODE=1.
rem
rem Manual repair, run from the install directory:
rem   resources\extract-runtime.cmd --force
rem
rem NOTE: keep this file ASCII-only. cmd.exe reads .cmd files using the OEM code
rem page (e.g. GBK on Chinese Windows), so UTF-8 comments would be decoded into
rem garbage and executed as commands.
rem ---------------------------------------------------------------------------
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\DSH Desktop.exe" "%~dp0extract-runtime.cjs" %*
set "CODE=%ERRORLEVEL%"
endlocal & exit /b %CODE%
