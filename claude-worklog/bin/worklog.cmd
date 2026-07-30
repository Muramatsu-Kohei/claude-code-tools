@echo off
rem Shortcut wrapper for claude-worklog (cmd / PowerShell).
rem Git Bash uses the extensionless "worklog" in the same directory.
rem Comments are ASCII-only: cmd reads .cmd files in the OEM code page,
rem so UTF-8 Japanese here would be garbled and parsed as commands.
rem Rewrite the path below to match your environment.
node "C:/claude/ClaudeCode/claude-worklog/worklog.js" %*
