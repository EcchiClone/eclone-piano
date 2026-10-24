$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

try {
    Add-Type -Path (Join-Path $PSScriptRoot 'MidiBridge.cs') -ReferencedAssemblies 'System.Web.Extensions', 'System.Core'
    [PianoVisualizer.Native.MidiBridge]::Run()
}
catch {
    $failure = @{ type = 'error'; code = 'bridge-startup'; message = $_.Exception.Message }
    [Console]::WriteLine(($failure | ConvertTo-Json -Compress))
    exit 1
}
