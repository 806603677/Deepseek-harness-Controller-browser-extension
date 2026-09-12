param(
    [ValidateSet('Edge', 'Chrome')]
    [string]$Browser = 'Edge'
)

$ErrorActionPreference = 'Stop'
$browserRegistry = if ($Browser -eq 'Chrome') { 'Google\Chrome' } else { 'Microsoft\Edge' }
$registryPath = "HKCU:\Software\$browserRegistry\NativeMessagingHosts\com.dsh.edge"
if (Test-Path -LiteralPath $registryPath) {
    Remove-Item -LiteralPath $registryPath -Recurse -Force
    Write-Output "Removed the DSH $Browser Native Host registration for the current user."
} else {
    Write-Output 'DSH Edge Native Host registration was not present.'
}
Write-Output 'The extension and project files were left intact.'
