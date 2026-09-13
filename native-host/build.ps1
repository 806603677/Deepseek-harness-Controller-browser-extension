param(
    [string]$OutputDirectory = ""
)

$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'DshEdgeNativeHost.cs'
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $PSScriptRoot 'bin'
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$output = Join-Path $OutputDirectory 'DshEdgeNativeHost-0.9.0.exe'

$candidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$compiler = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $compiler) { throw 'C# compiler not found: install the .NET Framework 4.x development tools' }

& $compiler /nologo /target:exe /optimize+ /out:$output /reference:System.dll /reference:System.Core.dll /reference:System.Web.Extensions.dll $source
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $output)) {
    throw 'Native Host compilation failed.'
}

Write-Output $output
