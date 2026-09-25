# Esprin Nemo - Windows system speech recognition bridge (one process per dictation session).
#
# Why this file is ASCII-only with English comments:
#   Windows PowerShell 5.1 reads BOM-less .ps1 files as ANSI, so non-ASCII source breaks parsing.
#   The host script (src/main/speech_windows.js) therefore never runs this file from disk:
#   it reads the text, encodes it as UTF-16LE base64 and passes it via -EncodedCommand,
#   which also removes every command-line quoting question.
#
# Engine: System.Speech.Recognition.SpeechRecognitionEngine + DictationGrammar.
#   The desktop recognizer runs entirely on this machine (no service, no network):
#   dictation audio never leaves the machine, which is what the app promises.
#   The Windows.Media.SpeechRecognition (WinRT) dictation scenario is not used on purpose:
#   its topic grammar is provided by an online service, and its Constraints collection
#   cannot be built from PowerShell (the COM projection exposes no Add).
#
# Protocol: one JSON object per line on stdout, all non-ASCII escaped as \uXXXX so the
#   console code page cannot corrupt the stream. Types:
#   status  - engines[] / systemCulture          (one-shot -Mode status)
#   ready   - engine id + culture                (listen mode, after audio input is armed)
#   partial - interim text for the current utterance
#   final   - finalized text with confidence
#   rejected- utterance was heard but not matched
#   error   - code + message, followed by exit 1
#
# Injected by the host before encoding: $mode ('status' | 'listen') and $culture ('zh-CN', ...).
if (-not $mode) { $mode = 'status' }
if (-not $culture) { $culture = '' }

$ErrorActionPreference = 'Stop'

function ConvertTo-AsciiJson($value) {
    $json = $value | ConvertTo-Json -Depth 6 -Compress
    $builder = New-Object System.Text.StringBuilder
    foreach ($ch in $json.ToCharArray()) {
        if ([int]$ch -lt 128) { $null = $builder.Append($ch) }
        else { $null = $builder.Append('\u' + ('{0:x4}' -f [int]$ch)) }
    }
    return $builder.ToString()
}

function Write-EventLine([string]$type, $extra) {
    $payload = [ordered]@{ type = $type }
    if ($extra) {
        foreach ($key in $extra.Keys) { $payload[$key] = $extra[$key] }
    }
    [Console]::Out.WriteLine((ConvertTo-AsciiJson $payload))
    [Console]::Out.Flush()
}

try {
    Add-Type -AssemblyName System.Speech
} catch {
    Write-EventLine 'error' @{ code = 'Engine'; message = $_.Exception.Message }
    exit 1
}

function Get-InstalledEngines {
    $list = @()
    foreach ($info in [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()) {
        $list += [ordered]@{
            id          = $info.Id
            culture     = $info.Culture.Name
            description = $info.Description
        }
    }
    return $list
}

if ($mode -eq 'status') {
    Write-EventLine 'status' @{
        engines       = Get-InstalledEngines
        systemCulture = [System.Globalization.CultureInfo]::CurrentCulture.Name
    }
    exit 0
}

# ---- listen mode ----
$engine = $null
try {
    if ($culture) {
        $cultureInfo = [System.Globalization.CultureInfo]::GetCultureInfo($culture)
        $engine = New-Object -TypeName System.Speech.Recognition.SpeechRecognitionEngine -ArgumentList $cultureInfo
    } else {
        $engine = New-Object -TypeName System.Speech.Recognition.SpeechRecognitionEngine
    }
} catch {
    Write-EventLine 'error' @{ code = 'NoRecognizer'; culture = $culture; message = $_.Exception.Message }
    exit 1
}

try {
    # DictationGrammar is the free-form grammar; it is evaluated by the local engine.
    $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
    $engine.SetInputToDefaultAudioDevice()
} catch {
    Write-EventLine 'error' @{ code = 'AudioDevice'; message = $_.Exception.Message }
    if ($engine) { try { $engine.Dispose() } catch { } }
    exit 1
}

Register-ObjectEvent -InputObject $engine -EventName SpeechRecognized -SourceIdentifier EsprinSpeechFinal | Out-Null
Register-ObjectEvent -InputObject $engine -EventName SpeechHypothesized -SourceIdentifier EsprinSpeechPartial | Out-Null
Register-ObjectEvent -InputObject $engine -EventName SpeechRecognitionRejected -SourceIdentifier EsprinSpeechRejected | Out-Null

try {
    # Multiple: keep recognizing until the session is cancelled, so the caller can dictate for as long as it likes.
    $engine.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
} catch {
    Write-EventLine 'error' @{ code = 'Recognition'; message = $_.Exception.Message }
    $engine.Dispose()
    exit 1
}

Write-EventLine 'ready' @{
    engine  = $engine.RecognizerInfo.Id
    culture = $engine.RecognizerInfo.Culture.Name
}

$sources = @('EsprinSpeechFinal', 'EsprinSpeechPartial', 'EsprinSpeechRejected')
while ($true) {
    $events = @(Get-Event | Where-Object { $sources -contains $_.SourceIdentifier })
    foreach ($evt in $events) {
        $result = $evt.SourceEventArgs.Result
        switch ($evt.SourceIdentifier) {
            'EsprinSpeechFinal' {
                Write-EventLine 'final' @{ text = $result.Text; confidence = [double]$result.Confidence }
            }
            'EsprinSpeechPartial' {
                Write-EventLine 'partial' @{ text = $result.Text }
            }
            'EsprinSpeechRejected' {
                Write-EventLine 'rejected' @{}
            }
        }
        Remove-Event -EventIdentifier $evt.EventIdentifier -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 80
}
