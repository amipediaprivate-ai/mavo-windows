$ErrorActionPreference = "Stop"

$archiveName = "ffmpeg-n8.1-latest-win64-lgpl-8.1.zip"
$preparationRevision = "3"
$releaseBase = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$destination = Join-Path $projectRoot "src-tauri\resources\ffmpeg"
$marker = Join-Path $destination ".mavo-ffmpeg-ready"
$ffmpegExe = Join-Path $destination "ffmpeg.exe"
$ffprobeExe = Join-Path $destination "ffprobe.exe"

if ((Test-Path -LiteralPath $ffmpegExe) -and (Test-Path -LiteralPath $ffprobeExe) -and (Test-Path -LiteralPath $marker)) {
    $installedMarker = (Get-Content -LiteralPath $marker -Raw).Trim().ToLowerInvariant()
    if ($installedMarker.EndsWith(":$preparationRevision")) {
        Write-Output "FFmpeg 8.1 sidecar is ready."
        exit 0
    }
}

$checksumsResponse = Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/checksums.sha256"
$checksums = [System.Text.Encoding]::UTF8.GetString($checksumsResponse.Content)
$checksumLine = ($checksums -split "`n" | Where-Object { $_ -match "\s+$([regex]::Escape($archiveName))\s*$" } | Select-Object -First 1)
if (-not $checksumLine) {
    throw "FFmpeg checksum not found for $archiveName"
}
$expectedHash = ($checksumLine -split "\s+")[0].ToLowerInvariant()
$markerValue = "$expectedHash`:$preparationRevision"

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "mavo-ffmpeg-$PID"
$archivePath = Join-Path $tempRoot $archiveName
$extractPath = Join-Path $tempRoot "extract"

try {
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    Write-Output "Downloading FFmpeg 8.1 LGPL runtime..."
    Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/$archiveName" -OutFile $archivePath
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        throw "FFmpeg SHA-256 verification failed. Expected $expectedHash, got $actualHash."
    }

    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractPath -Force
    $sourceFfmpeg = Get-ChildItem -LiteralPath $extractPath -Recurse -Filter "ffmpeg.exe" -File | Select-Object -First 1
    if (-not $sourceFfmpeg) {
        throw "The FFmpeg archive does not contain ffmpeg.exe."
    }
    $sourceBin = $sourceFfmpeg.Directory.FullName
    if (-not (Test-Path -LiteralPath (Join-Path $sourceBin "ffprobe.exe"))) {
        throw "The FFmpeg archive does not contain ffprobe.exe."
    }

    if (Test-Path -LiteralPath $destination) {
        $resolvedDestination = (Resolve-Path -LiteralPath $destination).Path
        $resourcesRoot = Join-Path $projectRoot "src-tauri\resources"
        if (-not $resolvedDestination.StartsWith($resourcesRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to replace FFmpeg outside the project resources directory: $resolvedDestination"
        }
        Remove-Item -LiteralPath $resolvedDestination -Recurse -Force
    }
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    foreach ($runtimeName in @("ffmpeg.exe", "ffprobe.exe")) {
        Copy-Item -LiteralPath (Join-Path $sourceBin $runtimeName) -Destination $destination -Force
    }

    $archiveRoot = $sourceFfmpeg.Directory.Parent.FullName
    foreach ($noticeName in @("LICENSE.txt", "README.txt")) {
        $notice = Join-Path $archiveRoot $noticeName
        if (Test-Path -LiteralPath $notice) {
            Copy-Item -LiteralPath $notice -Destination (Join-Path $destination "FFmpeg-$noticeName") -Force
        }
    }
    $versionLine = (& (Join-Path $destination "ffmpeg.exe") -version | Select-Object -First 1)
    $commitMatch = [regex]::Match($versionLine, "-g([0-9a-f]{7,40})-")
    $sourceUrl = if ($commitMatch.Success) {
        "https://github.com/FFmpeg/FFmpeg/tree/$($commitMatch.Groups[1].Value)"
    } else {
        "https://ffmpeg.org/releases/ffmpeg-8.1.tar.xz"
    }
    $buildInfo = @(
        $versionLine
        "Binary archive: $archiveName"
        "Binary SHA-256: $expectedHash"
        "Corresponding source: $sourceUrl"
        "Build scripts: https://github.com/BtbN/FFmpeg-Builds"
    ) -join [Environment]::NewLine
    Set-Content -LiteralPath (Join-Path $destination "FFmpeg-BUILD.txt") -Value $buildInfo -Encoding utf8
    Set-Content -LiteralPath $marker -Value $markerValue -Encoding ascii -NoNewline
    Write-Output "FFmpeg 8.1 LGPL runtime prepared and verified."
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
