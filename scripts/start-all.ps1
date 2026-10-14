param(
    [switch]$Watch,
    [switch]$Dev
)

# Jarvis Local AI Agent: 1-Click Master Launcher
# Starts Web Workstation, Telegram Bot, and Dev Agent in a single process

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " ⚡ Launching Jarvis Local AI Agent (All Services) ⚡      " -ForegroundColor Cyan
Write-Host " Workstation: ASUS ROG Flow Z13 (Radeon 8060S)           " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

if ($Watch -or $Dev) {
    pnpm run dev
} else {
    pnpm start
}

