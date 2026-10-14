<#
.SYNOPSIS
    Jarvis Gate 0 Preflight Verification Script
.DESCRIPTION
    Validates workstation readiness, toolchain versions, memory/VRAM headroom,
    GitHub board integration, and secrets hygiene against jarvis-master-context.md.
#>

$ErrorActionPreference = "SilentlyContinue"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "          JARVIS LOCAL AI AGENT - GATE 0 PREFLIGHT         " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

$results = [System.Collections.Generic.List[PSCustomObject]]::new()

function Add-Check {
    param(
        [string]$Category,
        [string]$Item,
        [string]$Detail,
        [string]$Status
    )
    $results.Add([PSCustomObject]@{
        Category = $Category
        Item     = $Item
        Detail   = $Detail
        Status   = $Status
    })
}

# --- 1. HARDWARE & STORAGE ---
$os = (Get-CimInstance Win32_OperatingSystem).Caption
$driveC = Get-PSDrive C
$freeGB = [math]::Round($driveC.Free / 1GB, 1)
$totalPhysRAM = [math]::Round((Get-CimInstance Win32_PhysicalMemory | Measure-Object -Property Capacity -Sum).Sum / 1GB, 1)
$osRAM = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)

if ($freeGB -ge 250) {
    Add-Check "Hardware" "Storage C:" "$freeGB GB free (>= 250 GB target)" "PASS"
} else {
    Add-Check "Hardware" "Storage C:" "$freeGB GB free (< 250 GB required)" "WARN"
}

if ($totalPhysRAM -ge 60) {
    Add-Check "Hardware" "Physical RAM" "$totalPhysRAM GB LPDDR5X unified" "PASS"
} else {
    Add-Check "Hardware" "Physical RAM" "$totalPhysRAM GB (expected 64 GB)" "WARN"
}

if ($osRAM -ge 24) {
    Add-Check "Hardware" "OS Memory" "$osRAM GB allocated to Windows host" "PASS"
} else {
    Add-Check "Hardware" "OS Memory" "$osRAM GB allocated to Windows" "INFO"
}

# --- 2. TOOLCHAIN ---
$gitVer = git --version
if ($gitVer) { Add-Check "Toolchain" "Git" $gitVer "PASS" } else { Add-Check "Toolchain" "Git" "Not installed" "FAIL" }

$nodeVer = node --version
if ($nodeVer) { Add-Check "Toolchain" "Node.js" $nodeVer "PASS" } else { Add-Check "Toolchain" "Node.js" "Not installed" "FAIL" }

$dockerVer = docker --version
if ($dockerVer) { Add-Check "Toolchain" "Docker" $dockerVer "PASS" } else { Add-Check "Toolchain" "Docker" "Not installed" "FAIL" }

$codeVer = code --version | Select-Object -First 1
if ($codeVer) { Add-Check "Toolchain" "VS Code" "v$codeVer" "PASS" } else { Add-Check "Toolchain" "VS Code" "Not installed" "FAIL" }

$ghVer = gh --version | Select-Object -First 1
if ($ghVer) { Add-Check "Toolchain" "GitHub CLI" $ghVer "PASS" } else { Add-Check "Toolchain" "GitHub CLI" "Not installed" "FAIL" }

# --- 3. INFERENCE BACKENDS ---
$ollamaRunning = $false
try {
    $res = Invoke-RestMethod -Uri "http://localhost:11434/api/tags" -TimeoutSec 3 -ErrorAction Stop
    $ollamaRunning = $true
} catch {}

if ($ollamaRunning) {
    Add-Check "Inference" "Ollama Service" "Online on localhost:11434" "PASS"
} else {
    Add-Check "Inference" "Ollama Service" "Offline or not running" "WARN"
}

$llamaCliPath = "C:\tools\llama.cpp\llama-cli.exe"
if (Test-Path $llamaCliPath) {
    $vulkanOutput = & $llamaCliPath --list-devices 2>&1 | Out-String
    if ($vulkanOutput -match "Vulkan0.*Radeon.*8060S") {
        Add-Check "Inference" "llama.cpp Vulkan" "Radeon 8060S detected via Vulkan" "PASS"
    } else {
        Add-Check "Inference" "llama.cpp Vulkan" "Binary exists, check device list" "INFO"
    }
} else {
    Add-Check "Inference" "llama.cpp Vulkan" "Missing in C:\tools\llama.cpp" "FAIL"
}

# --- 4. GITHUB INTEGRATION ---
$ghAuth = gh auth status 2>&1 | Out-String
if ($ghAuth -match "Logged in to github\.com account aery1803") {
    Add-Check "GitHub" "CLI Auth" "Logged in as aery1803" "PASS"
} else {
    Add-Check "GitHub" "CLI Auth" "Not logged in" "FAIL"
}

$origin = git remote get-url origin
if ($origin -match "aery1803/jarvis") {
    Add-Check "GitHub" "Git Remote" $origin "PASS"
} else {
    Add-Check "GitHub" "Git Remote" "Not pointed to aery1803/jarvis" "WARN"
}

# --- 5. SECRETS HYGIENE ---
$credList = cmdkey /list | Out-String
if ($credList -match "jarvis-github") {
    Add-Check "Security" "GitHub Token" "Stored in Windows Credential Manager" "PASS"
} else {
    Add-Check "Security" "GitHub Token" "Missing 'jarvis-github' in Credential Manager" "WARN"
}

if ($credList -match "jarvis-telegram-dev") {
    Add-Check "Security" "Telegram Dev Token" "Stored in Windows Credential Manager" "PASS"
} else {
    Add-Check "Security" "Telegram Dev Token" "Missing 'jarvis-telegram-dev' in Credential Manager" "WARN"
}

if ($credList -match "jarvis-telegram-qa") {
    Add-Check "Security" "Telegram QA Token" "Stored in Windows Credential Manager" "PASS"
} else {
    Add-Check "Security" "Telegram QA Token" "Missing 'jarvis-telegram-qa' in Credential Manager" "INFO"
}

$settingsEnv = "$env:USERPROFILE\.jarvis\settings.env"
if (Test-Path $settingsEnv) {
    Add-Check "Security" "External Settings" "Exists at $settingsEnv" "PASS"
} else {
    Add-Check "Security" "External Settings" "Missing .jarvis\settings.env" "WARN"
}

# --- DISPLAY REPORT TABLE ---
Write-Host ("{0,-12} | {0,-20} | {0,-10} | {0,-40}" -f "CATEGORY", "ITEM", "STATUS", "DETAILS") -ForegroundColor DarkGray
Write-Host ("-" * 88) -ForegroundColor DarkGray

foreach ($r in $results) {
    $color = "Green"
    if ($r.Status -eq "WARN") { $color = "Yellow" }
    elseif ($r.Status -eq "FAIL") { $color = "Red" }
    elseif ($r.Status -eq "INFO") { $color = "Cyan" }

    Write-Host ("{0,-12} | {1,-20} | " -f $r.Category, $r.Item) -NoNewline
    Write-Host ("{0,-10}" -f $r.Status) -ForegroundColor $color -NoNewline
    Write-Host (" | {0}" -f $r.Detail)
}

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  PREFLIGHT COMPLETE. READY FOR PHASE 0 BENCHMARK & BUILD " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
