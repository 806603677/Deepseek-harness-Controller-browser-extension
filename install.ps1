param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId,
    [ValidateSet('Edge', 'Chrome')]
    [string]$Browser = 'Edge'
)

$ErrorActionPreference = 'Stop'
$hostDirectory = Join-Path $PSScriptRoot 'native-host'
$buildScript = Join-Path $hostDirectory 'build.ps1'
$hostExe = & $buildScript
$hostExe = [System.IO.Path]::GetFullPath(($hostExe | Select-Object -Last 1))

$runtimeDirectory = Join-Path $PSScriptRoot 'runtime'
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
$hostManifest = Join-Path $runtimeDirectory ("com.dsh.edge.$($Browser.ToLowerInvariant()).json")
$manifest = [ordered]@{
    name = 'com.dsh.edge'
    description = 'DSH Edge Native Messaging bridge'
    path = $hostExe
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $hostManifest -Encoding UTF8

$browserRegistry = if ($Browser -eq 'Chrome') { 'Google\Chrome' } else { 'Microsoft\Edge' }
$registryPath = "HKCU:\Software\$browserRegistry\NativeMessagingHosts\com.dsh.edge"
New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value ([System.IO.Path]::GetFullPath($hostManifest))

Write-Output "DSH Native Host installed for $Browser and the current Windows user."
Write-Output ("Extension ID : " + $ExtensionId)
Write-Output ("Host executable: " + $hostExe)
Write-Output ("Host manifest : " + $hostManifest)
Write-Output "Reload the extension on $Browser's extensions page, then open its popup."
