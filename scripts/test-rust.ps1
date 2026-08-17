$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repositoryRoot "src-tauri\caevir.test.manifest"
$cargoManifest = Join-Path $repositoryRoot "src-tauri\Cargo.toml"
$previousRustFlags = $env:RUSTFLAGS

try {
    $manifestFlags = "-C link-arg=/MANIFEST:EMBED -C link-arg=/MANIFESTINPUT:$manifestPath"
    $env:RUSTFLAGS = if ($previousRustFlags) {
        "$previousRustFlags $manifestFlags"
    } else {
        $manifestFlags
    }
    & cargo test --manifest-path $cargoManifest --lib @args
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
} finally {
    $env:RUSTFLAGS = $previousRustFlags
}
