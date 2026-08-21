@echo off
rem Shortcut wrapper for the Claude account swapper (cmd / PowerShell).
rem Comments are ASCII-only: cmd reads .cmd files in the OEM code page,
rem so UTF-8 Japanese here would be garbled and parsed as commands.
rem %~dp0 is this file's own directory, and swap.js sits next to it,
rem so this works from any checkout without editing a path in.
rem Do NOT call this from a scheduled task or a hook: swapping credentials
rem takes effect machine-wide at once and hijacks running sessions.
node "%~dp0swap.js" %*
