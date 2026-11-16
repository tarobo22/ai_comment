[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$appDirectory = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
$launcherSource = Join-Path $PSScriptRoot 'Launcher.cs'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
foreach ($requiredFile in @($launcherSource, $compiler)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Build prerequisite is missing: $requiredFile"
    }
}

Add-Type -AssemblyName System.IO.Compression.FileSystem

$nodeRelease = 'node-v24.15.0-win-x64'
$nodeArchiveHash = 'cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62'
$tempDirectory = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).ProviderPath
$scratchName = 'AIComment-build-' + [Guid]::NewGuid().ToString('N')
$scratchDirectory = Join-Path $tempDirectory $scratchName

try {
    $payloadDirectory = Join-Path $scratchDirectory 'payload'
    $dependencyDirectory = Join-Path $scratchDirectory 'dependencies'
    $licenseDirectory = Join-Path $payloadDirectory 'licenses'
    $payloadModules = Join-Path $payloadDirectory 'node_modules'
    New-Item -ItemType Directory -Path $dependencyDirectory, $licenseDirectory, $payloadModules | Out-Null

    $nodeArchive = Join-Path $scratchDirectory "$nodeRelease.zip"
    Write-Host "Downloading the official $nodeRelease runtime..."
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v24.15.0/$nodeRelease.zip" -OutFile $nodeArchive
    $downloadHash = (Get-FileHash -LiteralPath $nodeArchive -Algorithm SHA256).Hash
    if ($downloadHash -ine $nodeArchiveHash) {
        throw "Node.js archive failed SHA-256 verification: $downloadHash"
    }
    [IO.Compression.ZipFile]::ExtractToDirectory($nodeArchive, $scratchDirectory)
    $nodeDirectory = Join-Path $scratchDirectory $nodeRelease
    $nodeExe = Join-Path $nodeDirectory 'node.exe'
    Copy-Item -LiteralPath $nodeExe -Destination $payloadDirectory
    Copy-Item -LiteralPath (Join-Path $nodeDirectory 'LICENSE') -Destination (Join-Path $licenseDirectory 'Node.js.txt')

    foreach ($fileName in @('package.json', 'package-lock.json')) {
        Copy-Item -LiteralPath (Join-Path $appDirectory $fileName) -Destination $dependencyDirectory
    }

    Write-Host 'Installing production dependencies from package-lock.json...'
    $npmCli = Join-Path $nodeDirectory 'node_modules\npm\bin\npm-cli.js'
    Push-Location -LiteralPath $dependencyDirectory
    try {
        & $nodeExe $npmCli ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
        if ($LASTEXITCODE -ne 0) {
            throw "npm ci failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }

    $installedModules = Join-Path $dependencyDirectory 'node_modules'
    Get-ChildItem -LiteralPath $installedModules -Directory |
        Where-Object Name -ne '.bin' |
        Copy-Item -Destination $payloadModules -Recurse

    $runtimeFiles = @(
        'ai.mjs', 'google.mjs', 'local-gemini-key.mjs', 'public-reader.mjs', 'server.mjs', 'store.mjs',
        'public/app.js', 'public/index.html', 'public/style.css',
        'chrome-extension/background.js', 'chrome-extension/manifest.json',
        'chrome-extension/studio.js', 'chrome-extension/youtube.js'
    )
    $runtimeDirectories = 'public', 'chrome-extension'
    foreach ($directoryName in $runtimeDirectories) {
        New-Item -ItemType Directory -Path (Join-Path $payloadDirectory $directoryName) | Out-Null
    }
    foreach ($fileName in $runtimeFiles) {
        Copy-Item -LiteralPath (Join-Path $appDirectory $fileName) -Destination (Join-Path $payloadDirectory $fileName)
    }

    $payloadZip = Join-Path $scratchDirectory 'AIComment.Payload.zip'
    [IO.Compression.ZipFile]::CreateFromDirectory($payloadDirectory, $payloadZip, [IO.Compression.CompressionLevel]::Optimal, $false)

    Write-Host 'Compiling AIComment.exe...'
    $builtExe = Join-Path $scratchDirectory 'AIComment.exe'
    $compilerArguments = @(
        '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001',
        '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.IO.Compression.dll',
        "/resource:$payloadZip,AIComment.Payload.zip", "/out:$builtExe", $launcherSource
    )
    & $compiler @compilerArguments
    if ($LASTEXITCODE -ne 0) {
        throw "C# compilation failed with exit code $LASTEXITCODE."
    }

    $distDirectory = Join-Path $appDirectory 'dist'
    New-Item -ItemType Directory -Path $distDirectory -Force | Out-Null
    $distExe = Join-Path $distDirectory 'AIComment.exe'
    Copy-Item -LiteralPath $builtExe -Destination $distExe -Force
    Get-Item -LiteralPath $distExe
}
finally {
    if (Test-Path -LiteralPath $scratchDirectory -PathType Container) {
        $resolvedScratch = (Resolve-Path -LiteralPath $scratchDirectory).ProviderPath
        $resolvedParent = [IO.Path]::GetDirectoryName($resolvedScratch)
        $resolvedName = [IO.Path]::GetFileName($resolvedScratch)
        if ($resolvedParent -ieq $tempDirectory.TrimEnd('\') -and $resolvedName -ceq $scratchName) {
            Remove-Item -LiteralPath $resolvedScratch -Recurse -Force
        }
    }
}
