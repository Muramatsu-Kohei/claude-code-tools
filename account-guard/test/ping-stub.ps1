# Stub for CLAUDE_WINDOW_PING, used by fault.test.js and swap.test.js.
#
# `swap warmup` runs the script that CLAUDE_WINDOW_PING points at. The real one
# (claude-window-keeper/claude-window-ping.ps1) sends `claude -p`, which consumes a
# 5-hour window for real. Tests must always point at this stub instead.
#
# PING_LOG:  append one line per invocation, holding the refreshToken that is logged in
#            at that moment. That is what lets a test assert the core of the spec --
#            "switch to each account, then ping" -- rather than just counting calls.
# PING_EXIT: exit with this code instead of 0 (to exercise the failure path).
#
# Comments are ASCII on purpose: Windows PowerShell 5.1 reads a BOM-less UTF-8 script
# as the ANSI code page, which mangles non-ASCII bytes.

if ($env:PING_LOG) {
    $token = '(missing)'
    $credPath = Join-Path $env:USERPROFILE '.claude\.credentials.json'
    if (Test-Path $credPath) {
        try {
            $token = (Get-Content -Raw -Path $credPath | ConvertFrom-Json).claudeAiOauth.refreshToken
        } catch {
            $token = '(unreadable)'
        }
    }
    Add-Content -Path $env:PING_LOG -Value $token
}
if ($env:PING_EXIT) {
    exit [int]$env:PING_EXIT
}
exit 0
