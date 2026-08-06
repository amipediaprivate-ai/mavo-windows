$ErrorActionPreference = "Stop"

$pythonVersion = "3.12.6"
$pythonArchive = "python-$pythonVersion-embed-amd64.zip"
$pythonSha256 = "a86a2e28870967745d255cc597d1e4d19ae79e65e927cdc324baa0256202231c"
$pipVersion = "25.2"
$rembgVersion = "2.0.75"
$preparationRevision = "1"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$destination = Join-Path $projectRoot "src-tauri\resources\rembg-runtime"
$marker = Join-Path $destination ".caevir-rembg-ready"
$markerValue = "$pythonVersion`:$pipVersion`:$rembgVersion`:$preparationRevision"
$pythonExe = Join-Path $destination "python.exe"

if ((Test-Path -LiteralPath $pythonExe) -and (Test-Path -LiteralPath $marker)) {
    if ((Get-Content -LiteralPath $marker -Raw).Trim() -eq $markerValue) {
        Write-Output "rembg $rembgVersion runtime is ready."
        exit 0
    }
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "caevir-rembg-$PID"
$pythonArchivePath = Join-Path $tempRoot $pythonArchive
$pipWheelPath = Join-Path $tempRoot "pip-$pipVersion-py3-none-any.whl"
$extractPath = Join-Path $tempRoot "python"

try {
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    Write-Output "Downloading Python $pythonVersion embeddable runtime..."
    Invoke-WebRequest -UseBasicParsing -Uri "https://www.python.org/ftp/python/$pythonVersion/$pythonArchive" -OutFile $pythonArchivePath
    $actualPythonHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $pythonArchivePath).Hash.ToLowerInvariant()
    if ($actualPythonHash -ne $pythonSha256) {
        throw "Python SHA-256 verification failed. Expected $pythonSha256, got $actualPythonHash."
    }
    Expand-Archive -LiteralPath $pythonArchivePath -DestinationPath $extractPath -Force

    $pthPath = Join-Path $extractPath "python312._pth"
    if (-not (Test-Path -LiteralPath $pthPath)) {
        throw "Python embedded path configuration is missing."
    }
    @(
        "python312.zip"
        "."
        "Lib/site-packages"
        "import site"
    ) | Set-Content -LiteralPath $pthPath -Encoding ascii
    New-Item -ItemType Directory -Path (Join-Path $extractPath "Lib\site-packages") -Force | Out-Null

    Write-Output "Downloading verified pip $pipVersion bootstrap wheel..."
    $pipMetadata = Invoke-RestMethod -Uri "https://pypi.org/pypi/pip/$pipVersion/json"
    $pipRelease = $pipMetadata.urls | Where-Object { $_.filename -eq "pip-$pipVersion-py3-none-any.whl" } | Select-Object -First 1
    if (-not $pipRelease) {
        throw "pip $pipVersion wheel metadata is unavailable."
    }
    Invoke-WebRequest -UseBasicParsing -Uri $pipRelease.url -OutFile $pipWheelPath
    $actualPipHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $pipWheelPath).Hash.ToLowerInvariant()
    if ($actualPipHash -ne $pipRelease.digests.sha256.ToLowerInvariant()) {
        throw "pip wheel SHA-256 verification failed."
    }

    Write-Output "Installing rembg $rembgVersion CPU runtime..."
    $bootstrap = "import sys; sys.path.insert(0, sys.argv[1]); from pip._internal.cli.main import main; sys.exit(main(sys.argv[2:]))"
    & (Join-Path $extractPath "python.exe") -c $bootstrap $pipWheelPath install --disable-pip-version-check --no-cache-dir --only-binary=:all: --target (Join-Path $extractPath "Lib\site-packages") "rembg[cpu]==$rembgVersion"
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to install rembg runtime packages."
    }
    & (Join-Path $extractPath "python.exe") -c "import rembg, onnxruntime, PIL; print('rembg runtime import verified')"
    if ($LASTEXITCODE -ne 0) {
        throw "The prepared rembg runtime failed its import check."
    }

    if (Test-Path -LiteralPath $destination) {
        $resolvedDestination = (Resolve-Path -LiteralPath $destination).Path
        $resourcesRoot = (Resolve-Path -LiteralPath (Join-Path $projectRoot "src-tauri\resources")).Path
        if (-not $resolvedDestination.StartsWith($resourcesRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to replace rembg runtime outside the resources directory: $resolvedDestination"
        }
        Remove-Item -LiteralPath $resolvedDestination -Recurse -Force
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Move-Item -LiteralPath $extractPath -Destination $destination
    Set-Content -LiteralPath $marker -Value $markerValue -Encoding ascii -NoNewline
    Write-Output "rembg $rembgVersion runtime prepared and verified."
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
