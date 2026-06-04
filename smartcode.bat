@echo off
if "%1"=="" goto usage
if "%2"=="" goto usage
docker run --rm -it -p 3000:3000 -v "%1:/workspace" -v "%2:/target-root" smartcode-lsp
goto end
:usage
echo Usage: %~nx0 worspace_folder algator_root_folder
:end