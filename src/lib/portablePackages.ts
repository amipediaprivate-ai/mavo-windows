import { Channel, invoke } from "@tauri-apps/api/core";

export interface PackageProgress {
  stage: string;
  completed: number;
  total: number;
  currentItem: string;
  message: string;
}

export interface PackageSummary {
  packagePath: string;
  projectId?: number;
  projectPath?: string;
  succeeded: number;
  reused: number;
  skipped: number;
  conflicts: number;
  failed: number;
  missing: number;
  messages: string[];
}

function invokeWithProgress(
  command: string,
  args: Record<string, unknown>,
  onProgress: (progress: PackageProgress) => void,
  operationId: string,
) {
  const onProgressChannel = new Channel<PackageProgress>();
  onProgressChannel.onmessage = onProgress;
  return invoke<PackageSummary>(command, { ...args, operationId, onProgress: onProgressChannel });
}

export function exportAssetPackage(assetIds: number[], outputPath: string, onProgress: (progress: PackageProgress) => void, operationId: string) {
  return invokeWithProgress("export_asset_package", { assetIds, outputPath }, onProgress, operationId);
}

export function importAssetPackage(packagePath: string, destinationParent: string, onProgress: (progress: PackageProgress) => void, operationId: string) {
  return invokeWithProgress("import_asset_package", { packagePath, destinationParent }, onProgress, operationId);
}

export function exportProjectArchive(projectId: number, outputPath: string, onProgress: (progress: PackageProgress) => void, operationId: string) {
  return invokeWithProgress("export_project_archive", { projectId, outputPath }, onProgress, operationId);
}

export function importProjectArchive(packagePath: string, destinationParent: string, onProgress: (progress: PackageProgress) => void, operationId: string) {
  return invokeWithProgress("import_project_archive", { packagePath, destinationParent }, onProgress, operationId);
}

export function cancelPackageOperation(operationId: string) {
  return invoke<void>("cancel_package_operation", { operationId });
}
