param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'dist')
)

$ErrorActionPreference = 'Stop'
$version = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'extension/manifest.json') -Raw | ConvertFrom-Json).version
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$archive = Join-Path $OutputDirectory "dsh-edge-controller-source-$version.zip"
if (Test-Path -LiteralPath $archive) { throw "Archive already exists; refusing to overwrite: $archive" }

$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-edge-package-" + [guid]::NewGuid().ToString('N'))
$packageRoot = Join-Path $staging 'dsh-edge-controller'
$files = @(
    '.gitignore', 'LICENSE', 'README.md', 'package.json', 'install.ps1', 'uninstall.ps1', 'package.ps1',
    'extension/manifest.json', 'extension/allowed-origins.js',
    'extension/service-worker.js', 'extension/page-tools.js', 'extension/workflow-advice.js',
    'extension/popup.html', 'extension/popup.js',
    'native-host/build.ps1', 'native-host/DshEdgeNativeHost.cs',
    'scripts/dsh-edge.mjs', 'tests/allowed-origins.mjs', 'tests/access-policy-worker.mjs',
    'tests/workflow-advice.mjs', 'tests/site-context-isolation.mjs', 'tests/example-skill-layout.mjs',
    'tests/bridge-roundtrip.mjs', 'tests/fixture-server.mjs', 'tests/fixtures/generic-form.html',
    'examples/agent-workspace/.gitignore', 'examples/agent-workspace/AGENTS.md',
    'examples/agent-workspace/SETUP.md', 'examples/agent-workspace/config.example.json',
    'examples/agent-workspace/scripts/site-context.mjs',
    'examples/agent-workspace/.agents/skills/site-workflow-router/SKILL.md',
    'examples/agent-workspace/.agents/skills/site-workflow-router/references/flow-criteria.md',
    'examples/agent-workspace/samples/site-skill/SKILL.md',
    'examples/agent-workspace/samples/page-memory.md'
)
try {
    foreach ($relative in $files) {
        $source = Join-Path $PSScriptRoot $relative
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing package input: $relative" }
        $target = Join-Path $packageRoot $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $target
    }
    Compress-Archive -LiteralPath $packageRoot -DestinationPath $archive
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($archive)
    try {
        $entries = @($zip.Entries | Where-Object { -not $_.FullName.EndsWith('/') } | ForEach-Object { $_.FullName.Replace('\', '/') })
        foreach ($relative in $files) {
            $expected = 'dsh-edge-controller/' + $relative
            if ($entries -cnotcontains $expected) { throw "Archive missing: $expected" }
        }
        if ($entries.Count -ne $files.Count) { throw 'Archive contains unexpected files' }
    } finally { $zip.Dispose() }
    Write-Output $archive
} finally {
    $fullStaging = [System.IO.Path]::GetFullPath($staging)
    $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($fullStaging.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $fullStaging) -match '^dsh-edge-package-[0-9a-f]{32}$') {
        Remove-Item -LiteralPath $fullStaging -Recurse -Force -ErrorAction SilentlyContinue
    }
}
