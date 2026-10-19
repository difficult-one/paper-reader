param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
$translationProject = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$translationOutput = Join-Path $translationProject 'output/translation-skill-evals/live-deepseek-20261018-final'
$translationConfiguration = Join-Path $translationProject 'output/translation-skill-evals/deepseek-authorized-20261018'
$translationSettings = Join-Path $translationConfiguration 'settings.json'
$translationPrices = Join-Path $translationConfiguration 'prices.json'
if (Test-Path -LiteralPath (Join-Path $translationOutput 'collection-state.json')) { throw 'This authorized experiment already started. Preserve its outputs and budget ledger; do not launch another paid run.' }
if (Test-Path -LiteralPath (Join-Path $translationOutput 'acceptance.lock')) { throw 'This experiment is already running or needs its interrupted ledger checked.' }
$null = Get-Content -LiteralPath $translationSettings -Raw | ConvertFrom-Json
$null = Get-Content -LiteralPath $translationPrices -Raw | ConvertFrom-Json
$translationPriorTotal = 0.0
foreach ($translationPriorName in @('live-deepseek-20261018', 'live-deepseek-20261018-corrected')) {
    $translationPriorPath = Join-Path $translationProject ('output/translation-skill-evals/' + $translationPriorName)
    $translationPriorState = Get-Content -LiteralPath (Join-Path $translationPriorPath 'collection-state.json') -Raw | ConvertFrom-Json
    if ($translationPriorState.status -eq 'running') { throw 'An earlier authorized collection is still running.' }
    $translationPriorLedger = Get-Content -LiteralPath (Join-Path $translationPriorPath 'budget-ledger.json') -Raw | ConvertFrom-Json
    $translationPriorTotal += [double]$translationPriorLedger.knownUsd + [double]$translationPriorLedger.reservedUsd
}
$translationRemainingBudget = 1.5 - $translationPriorTotal
if ($translationRemainingBudget -le 0) { throw 'The authorized total budget has been exhausted.' }
$translationBudgetText = $translationRemainingBudget.ToString('G17', [System.Globalization.CultureInfo]::InvariantCulture)
$translationNode = (Get-Command node -ErrorAction Stop).Source
$translationArguments = @((Join-Path $translationProject 'scripts/translation-acceptance.mjs'), '--live', '--settings', $translationSettings, '--prices', $translationPrices, '--budget-usd', $translationBudgetText, '--max-input-tokens', '65536', '--max-output-tokens', '16384', '--output', $translationOutput)
if ($ValidateOnly) { Write-Output 'Launcher validated. No key read, no window opened, no model request sent.'; return }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TranslationAcceptanceDialog {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr handle, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
}
'@
[System.Windows.Forms.Application]::EnableVisualStyles()
$translationForm = New-Object System.Windows.Forms.Form
$translationForm.Text = '论文翻译验收 · 输入 DeepSeek API 密钥'
$translationForm.ClientSize = New-Object System.Drawing.Size(590, 255)
$translationForm.StartPosition = 'CenterScreen'
$translationForm.FormBorderStyle = 'FixedDialog'
$translationForm.MaximizeBox = $false
$translationForm.MinimizeBox = $false
$translationForm.TopMost = $true
$translationExplanation = New-Object System.Windows.Forms.Label
$translationExplanation.Text = "模型：DeepSeek-V4.1-Flash-1017 · High 思考`n本次费用上限：人民币 10 元（按官方高峰单价保守预留）`n密钥仅传给本次采集进程，不写入文件或聊天。"
$translationExplanation.SetBounds(20, 15, 550, 65)
$translationLink = New-Object System.Windows.Forms.LinkLabel
$translationLink.Text = '打开 DeepSeek 控制台：创建并复制 API Key'
$translationLink.SetBounds(20, 88, 550, 23)
$translationLink.add_LinkClicked({ Start-Process 'https://platform.deepseek.com/api_keys' })
$translationKeyBox = New-Object System.Windows.Forms.TextBox
$translationKeyBox.UseSystemPasswordChar = $true
$translationKeyBox.SetBounds(20, 122, 550, 28)
$translationStart = New-Object System.Windows.Forms.Button
$translationStart.Text = '粘贴完成，开始验收'
$translationStart.SetBounds(315, 178, 155, 35)
$translationStart.DialogResult = [System.Windows.Forms.DialogResult]::OK
$translationCancel = New-Object System.Windows.Forms.Button
$translationCancel.Text = '取消'
$translationCancel.SetBounds(480, 178, 90, 35)
$translationCancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$translationForm.AcceptButton = $translationStart
$translationForm.CancelButton = $translationCancel
$translationForm.Controls.AddRange(@($translationExplanation, $translationLink, $translationKeyBox, $translationStart, $translationCancel))
$translationForm.add_Shown({
    $null = [TranslationAcceptanceDialog]::ShowWindowAsync($translationForm.Handle, 9)
    $null = [TranslationAcceptanceDialog]::SetForegroundWindow($translationForm.Handle)
    $translationKeyBox.Focus()
})
if ($translationForm.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { $translationKeyBox.Clear(); $translationForm.Dispose(); return }
$translationSecret = $translationKeyBox.Text.Trim()
$translationKeyBox.Clear(); $translationForm.Dispose()
if ([string]::IsNullOrWhiteSpace($translationSecret)) { throw 'No API key entered. No model request sent.' }
$translationProcessInfo = New-Object System.Diagnostics.ProcessStartInfo
$translationProcessInfo.FileName = $translationNode
$translationProcessInfo.WorkingDirectory = $translationProject
$translationProcessInfo.UseShellExecute = $false
$translationProcessInfo.CreateNoWindow = $true
$translationProcessInfo.RedirectStandardOutput = $true
$translationProcessInfo.RedirectStandardError = $true
foreach ($translationArgument in $translationArguments) { $translationProcessInfo.ArgumentList.Add($translationArgument) }
$translationProcessInfo.Environment['PAPER_READER_EXPERIMENT_API_KEY'] = $translationSecret
$translationChild = New-Object System.Diagnostics.Process
$translationChild.StartInfo = $translationProcessInfo
try {
    $null = $translationChild.Start()
    $translationSecret = $null
    $null = $translationProcessInfo.Environment.Remove('PAPER_READER_EXPERIMENT_API_KEY')
    $translationStdout = $translationChild.StandardOutput.ReadToEndAsync()
    $translationStderr = $translationChild.StandardError.ReadToEndAsync()
    $translationChild.WaitForExit()
    New-Item -ItemType Directory -Path $translationOutput -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $translationOutput 'launcher-result.log') -Value ($translationStdout.GetAwaiter().GetResult() + $translationStderr.GetAwaiter().GetResult()) -Encoding utf8
    if ($translationChild.ExitCode -eq 0) { $translationMessage = '模型采集完成。译文和费用账本已保存；人工盲评仍待完成。' }
    else { $translationMessage = '本次采集已停止。已有结果和账本已保存，请回到聊天查看；不要重复启动付费实验。' }
    $null = [System.Windows.Forms.MessageBox]::Show($translationMessage, '论文翻译验收')
} finally {
    $translationSecret = $null
    $null = $translationProcessInfo.Environment.Remove('PAPER_READER_EXPERIMENT_API_KEY')
    $translationChild.Dispose()
}
