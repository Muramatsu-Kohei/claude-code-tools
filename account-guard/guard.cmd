@echo off
rem Shortcut wrapper for the Claude account guard (cmd / PowerShell).
rem Comments are ASCII-only: cmd reads .cmd files in the OEM code page,
rem so UTF-8 Japanese here would be garbled and parsed as commands.
rem %~dp0 is this file's own directory, and the guard sits next to it,
rem so this works from any checkout without editing a path in.
rem `guard unlock` is meant to be typed by the user with a leading `!`
rem inside Claude Code: PreToolUse hooks do not fire for `!` commands,
rem which is what keeps Claude itself from lifting the guard.
node "%~dp0account-guard.js" %*
