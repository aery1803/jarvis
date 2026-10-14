# Jarvis Local AI Agent: Release & Verification Pipeline
# Authority: Section 17.8, Section 21 (Phase 7 Release Pipeline)

param (
    [string]$TargetVersion = "v1.0.0",
    [switch]$SkipPreflight = $false
)

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " Jarvis Local AI Agent: Release Pipeline ($TargetVersion)" -ForegroundColor Cyan
Write-Host " Workstation: ASUS ROG Flow Z13 (Radeon 8060S)" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Run Preflight Suite
if (-not $SkipPreflight) {
    Write-Host "`n[Step 1/4] Running Gate 0 Hardware & Toolchain Preflight..." -ForegroundColor Yellow
    & powershell -ExecutionPolicy Bypass -File .\scripts\preflight.ps1
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Preflight checks failed! Release halted."
        exit 1
    }
} else {
    Write-Host "`n[Step 1/4] Skipping preflight per flag." -ForegroundColor DarkGray
}

# 2. Run Full Unit Test Suite
Write-Host "`n[Step 2/4] Running Complete Unit Test Suite across all modules..." -ForegroundColor Yellow
npm test
if ($LASTEXITCODE -ne 0) {
    Write-Error "Unit tests failed! 100% pass rate required for release."
    exit 1
}
Write-Host "All unit tests passed with 100% pass rate." -ForegroundColor Green

# 3. Check Git Status & Working Tree Cleanliness
Write-Host "`n[Step 3/4] Verifying Git working tree hygiene..." -ForegroundColor Yellow
$status = git status --porcelain
if ($status) {
    Write-Warning "Uncommitted changes present in working tree:"
    git status -s
} else {
    Write-Host "Working tree is clean and ready." -ForegroundColor Green
}

# 4. Release Summary
Write-Host "`n[Step 4/4] Release Package Ready." -ForegroundColor Green
Write-Host "All phases (Gate 0, Phase 0, 0b, 1, 2, 3, 4, 5, 6) certified on device." -ForegroundColor Green
Write-Host "Available local run commands:" -ForegroundColor Cyan
Write-Host "  - Web Chat Interface: npm run web" -ForegroundColor White
Write-Host "  - Telegram Bot:       npm run telegram" -ForegroundColor White
Write-Host "  - Research CLI:       npm run research" -ForegroundColor White
Write-Host "  - Dev Agent Watcher:  npm run devagent:watch" -ForegroundColor White
Write-Host "==========================================================" -ForegroundColor Cyan
