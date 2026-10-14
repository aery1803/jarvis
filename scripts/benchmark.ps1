<#
.SYNOPSIS
    Jarvis Local Workstation Benchmark Suite
.DESCRIPTION
    Tests local LLM inference engines (Ollama and llama.cpp Vulkan) on AMD Radeon 8060S.
    Measures prompt processing tokens/sec, generation tokens/sec, and memory governor headroom.
#>

param(
    [string]$Model = "qwen2.5-coder:7b",
    [string]$OllamaUrl = "http://localhost:11434"
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "       JARVIS INFERENCE BENCHMARK - AMD RADEON 8060S       " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Model: $Model"
Write-Host "Target Endpoint: $OllamaUrl"
Write-Host ""

# 1. Host Memory Check
$osRAMBefore = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB, 2)
Write-Host "Host Available RAM Before Test: $osRAMBefore GB" -ForegroundColor Gray

# 2. Test Prompts
$warmupPrompt = "Write a quick hello-world function in TypeScript."
$heavyPrompt = @"
You are an expert systems engineer. Analyze the following scenario:
A local multi-agent system on an AMD Strix Halo APU with 64GB unified memory needs to manage
concurrent task execution across an Action Gateway, a vector database, and local inference models.
Design a memory governor architecture in TypeScript that tracks VRAM consumption, enforces 
cooldown pauses between inference loops, and prevents memory swapping.
Provide full code, error handling, and architecture explanation.
"@

# Function to run inference and calculate speed
function Run-BenchmarkPass {
    param(
        [string]$Name,
        [string]$PromptText,
        [int]$MaxTokens = 256
    )

    Write-Host "`n>>> Running: $Name ..." -ForegroundColor Yellow

    $body = @{
        model   = $Model
        prompt  = $PromptText
        stream  = $false
        options = @{
            num_predict = $MaxTokens
            temperature = 0.2
        }
    } | ConvertTo-Json

    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $response = Invoke-RestMethod -Uri "$OllamaUrl/api/generate" -Method Post -Body $body -ContentType "application/json"
    $stopwatch.Stop()

    $promptTokens = $response.prompt_eval_count
    $promptDurationSec = $response.prompt_eval_duration / 1e9
    $promptTPS = if ($promptDurationSec -gt 0) { [math]::Round($promptTokens / $promptDurationSec, 1) } else { 0 }

    $evalTokens = $response.eval_count
    $evalDurationSec = $response.eval_duration / 1e9
    $evalTPS = if ($evalDurationSec -gt 0) { [math]::Round($evalTokens / $evalDurationSec, 1) } else { 0 }

    $totalDurationSec = [math]::Round($response.total_duration / 1e9, 2)

    Write-Host "  Prompt Tokens    : $promptTokens tokens ($promptDurationSec s)" -ForegroundColor Gray
    Write-Host "  Prompt Speed     : $promptTPS tokens/sec" -ForegroundColor Green
    Write-Host "  Generated Tokens : $evalTokens tokens ($evalDurationSec s)" -ForegroundColor Gray
    Write-Host "  Generation Speed : $evalTPS tokens/sec" -ForegroundColor Green
    Write-Host "  Total Wall Time  : $totalDurationSec s" -ForegroundColor Gray

    return [PSCustomObject]@{
        PassName          = $Name
        PromptTokens      = $promptTokens
        PromptTPS         = $promptTPS
        GenerationTokens  = $evalTokens
        GenerationTPS     = $evalTPS
        TotalDurationSec  = $totalDurationSec
    }
}

# 3. Execution
$results = @()
$results += Run-BenchmarkPass -Name "Warmup & Initial Latency" -PromptText $warmupPrompt -MaxTokens 64
$results += Run-BenchmarkPass -Name "Sustained Code Generation" -PromptText $heavyPrompt -MaxTokens 350

# 4. Host Memory After Test
$osRAMAfter = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB, 2)
Write-Host "`nHost Available RAM After Test: $osRAMAfter GB" -ForegroundColor Gray

# 5. Output Summary Table
Write-Host "`n==========================================================" -ForegroundColor Cyan
Write-Host "                   BENCHMARK RESULTS                      " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
$results | Format-Table -Property PassName, PromptTPS, GenerationTPS, TotalDurationSec -AutoSize

$reportDir = "benchmarks/reports"
if (!(Test-Path $reportDir)) { New-Item -ItemType Directory -Path $reportDir -Force | Out-Null }
$safeModelName = $Model -replace '[:/\\*?"<>|]', '_'
$reportPath = Join-Path $reportDir "benchmark-$safeModelName-$(Get-Date -Format 'yyyyMMdd-HHmmss').json"
$results | ConvertTo-Json | Set-Content -Path $reportPath
Write-Host "Benchmark report saved locally to: $reportPath" -ForegroundColor Green
