<#
.SYNOPSIS
    Jarvis Auto-Pull: follows a branch on origin and fast-forwards this checkout when new commits land.
.DESCRIPTION
    Run it next to `npm run dev` on the workstation. nodemon watches src/, so every pull restarts Jarvis
    (web UI + Telegram bot) on the new code automatically.

    Safety rules:
    - Fast-forward only. If the checkout has uncommitted changes or has diverged from origin
      (local commits or a force-push), it stops pulling and says why.
    - Never installs packages (CODING_RULES Section 6). If package.json, the lockfile, pnpm-workspace.yaml
      or .npmrc change, it holds that update and prints the exact commands to review and install by hand.
.PARAMETER Branch
    Branch to follow. Defaults to the branch currently checked out. If different, it is checked out first.
.PARAMETER IntervalSeconds
    Seconds between fetches. Default 30.
.EXAMPLE
    npm run autopull -- -Branch fix/chat-streaming-context
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/auto-pull.ps1 -Branch main -IntervalSeconds 60
#>
param(
    [string]$Branch = "",
    [int]$IntervalSeconds = 30
)

# "Continue", not "Stop": under Windows PowerShell 5.1, git writing progress to stderr with 2>&1 would
# otherwise raise a terminating NativeCommandError. Failures are detected via $LASTEXITCODE instead.
$ErrorActionPreference = "Continue"
Set-Location (Split-Path -Parent $PSScriptRoot)

$DependencyFiles = '^(package\.json|pnpm-lock\.yaml|package-lock\.json|pnpm-workspace\.yaml|\.npmrc)$'

function Invoke-Git {
    param([string[]]$GitArgs)
    $output = & git @GitArgs 2>&1
    $text = (($output | ForEach-Object { "$_" }) -join "`n").Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "git $($GitArgs -join ' ') failed: $text"
    }
    return $text
}

function Test-DirtyTree {
    return [bool](Invoke-Git @('status', '--porcelain', '--untracked-files=no'))
}

function Write-Stamp {
    param([string]$Message, [string]$Color = 'Gray')
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $Message" -ForegroundColor $Color
}

try {
    $current = Invoke-Git @('rev-parse', '--abbrev-ref', 'HEAD')
    if (-not $Branch) { $Branch = $current }

    if ($Branch -ne $current) {
        if (Test-DirtyTree) {
            Write-Stamp "Uncommitted changes on '$current'. Commit or stash them before following '$Branch'." Red
            exit 1
        }
        Invoke-Git @('fetch', '--quiet', 'origin', $Branch) | Out-Null
        & git rev-parse --verify --quiet "refs/heads/$Branch" *> $null
        if ($LASTEXITCODE -eq 0) {
            Invoke-Git @('checkout', '--quiet', $Branch) | Out-Null
        } else {
            Invoke-Git @('checkout', '--quiet', '-b', $Branch, '--track', "origin/$Branch") | Out-Null
        }
        Write-Stamp "Switched to '$Branch'." Cyan
    }
} catch {
    Write-Stamp $_.Exception.Message Red
    exit 1
}

Write-Stamp "Following origin/$Branch every $IntervalSeconds s. Press Ctrl+C to stop." Cyan
$lastWarning = ""

while ($true) {
    try {
        Invoke-Git @('fetch', '--quiet', 'origin', $Branch) | Out-Null
        $local = Invoke-Git @('rev-parse', 'HEAD')
        $remote = Invoke-Git @('rev-parse', "origin/$Branch")

        if ($local -ne $remote) {
            $base = Invoke-Git @('merge-base', 'HEAD', "origin/$Branch")
            $warning = ""

            if ($base -ne $local) {
                $warning = "Local '$Branch' and origin have diverged (local commits or a force-push). Not pulling; resolve by hand."
            } elseif (Test-DirtyTree) {
                $warning = "Uncommitted local changes. Not pulling origin/$Branch until the tree is clean."
            } else {
                $changed = (Invoke-Git @('diff', '--name-only', $local, $remote)) -split "`n"
                $dependencyChanges = @($changed | Where-Object { $_ -match $DependencyFiles })
                if ($dependencyChanges.Count -gt 0) {
                    $warning = "origin/$Branch changes dependencies ($($dependencyChanges -join ', ')). Holding this update.`n" +
                        "  Review:  git diff HEAD origin/$Branch -- $($dependencyChanges -join ' ')`n" +
                        "  Then:    git merge --ff-only origin/$Branch`n" +
                        "           pnpm install --frozen-lockfile --ignore-scripts"
                } else {
                    Invoke-Git @('merge', '--ff-only', '--quiet', "origin/$Branch") | Out-Null
                    Write-Stamp "Pulled origin/$Branch -> $($remote.Substring(0, 7))" Green
                    (Invoke-Git @('log', '--oneline', "$local..$remote")) -split "`n" | ForEach-Object { Write-Host "    $_" }
                    $lastWarning = ""
                }
            }

            # Print each distinct warning once instead of every cycle.
            if ($warning -and $warning -ne $lastWarning) {
                Write-Stamp $warning Yellow
                $lastWarning = $warning
            }
        }
    } catch {
        Write-Stamp $_.Exception.Message Yellow
    }
    Start-Sleep -Seconds $IntervalSeconds
}
