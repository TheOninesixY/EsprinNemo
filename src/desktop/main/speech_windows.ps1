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
