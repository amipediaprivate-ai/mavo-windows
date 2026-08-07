$ErrorActionPreference = "Stop"

$releaseTag = "r2117"
$archiveName = "vgmstream-win64.zip"
$expectedHash = "6c4a8a3813864fefed081bbd337dbc0ad93bf88e0b92f5db98d7ab258b22dc6c"
$preparationRevision = "1"
$downloadUrl = "https://github.com/vgmstream/vgmstream/releases/download/$releaseTag/$archiveName"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$resourcesRoot = Join-Path $projectRoot "src-tauri\resources"
$destination = Join-Path $resourcesRoot "vgmstream"
$marker = Join-Path $destination ".caevir-vgmstream-ready"
$cliExe = Join-Path $destination "vgmstream-cli.exe"
$markerValue = "$releaseTag`:$expectedHash`:$preparationRevision"

if ((Test-Path -LiteralPath $cliExe) -and (Test-Path -LiteralPath $marker)) {
    if ((Get-Content -LiteralPath $marker -Raw).Trim() -eq $markerValue) {
        Write-Output "vgmstream $releaseTag runtime is ready."
        exit 0
    }
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "caevir-vgmstream-$PID"
$archivePath = Join-Path $tempRoot $archiveName
$extractPath = Join-Path $tempRoot "extract"

try {
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    Write-Output "Downloading vgmstream $releaseTag Windows x64 runtime..."
    Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $archivePath
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        throw "vgmstream SHA-256 verification failed. Expected $expectedHash, got $actualHash."
    }

    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractPath -Force
    $sourceCli = Get-ChildItem -LiteralPath $extractPath -Recurse -Filter "vgmstream-cli.exe" -File | Select-Object -First 1
    if (-not $sourceCli) {
        throw "The vgmstream archive does not contain vgmstream-cli.exe."
    }

    if (Test-Path -LiteralPath $destination) {
        $resolvedDestination = (Resolve-Path -LiteralPath $destination).Path
        if (-not $resolvedDestination.StartsWith($resourcesRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to replace vgmstream outside the project resources directory: $resolvedDestination"
        }
        Remove-Item -LiteralPath $resolvedDestination -Recurse -Force
    }
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Get-ChildItem -LiteralPath $sourceCli.Directory.FullName -File | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
    }

    $copying = Get-ChildItem -LiteralPath $extractPath -Recurse -Filter "COPYING" -File | Select-Object -First 1
    if ($copying) {
        Copy-Item -LiteralPath $copying.FullName -Destination (Join-Path $destination "COPYING") -Force
    } else {
        Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/vgmstream/vgmstream/$releaseTag/COPYING" -OutFile (Join-Path $destination "COPYING")
    }
    Set-Content -LiteralPath (Join-Path $destination "VGMSTREAM-BUILD.txt") -Encoding utf8 -Value @(
        "vgmstream release: $releaseTag"
        "Binary archive: $archiveName"
        "Binary SHA-256: $expectedHash"
        "Source: https://github.com/vgmstream/vgmstream/tree/$releaseTag"
    )
    Set-Content -LiteralPath $marker -Value $markerValue -Encoding ascii -NoNewline
    Write-Output "vgmstream $releaseTag runtime prepared and verified."
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        $resolvedTemp = (Resolve-Path -LiteralPath $tempRoot).Path
        $systemTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
        if ($resolvedTemp.StartsWith($systemTemp, [System.StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
        }
    }
}
