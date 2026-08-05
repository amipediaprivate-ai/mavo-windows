import { invoke } from "@tauri-apps/api/core";

export type ProjectStatus = "ready" | "missing" | "moving" | "error";
export type ProjectStorageMode = "reference" | "copy";
export type ProjectAssetStatus = "ready" | "source_missing" | "copy_missing" | "copying" | "error";

export interface Project {
  id: number;
  name: string;
  parentPath: string;
  rootPath: string;
  status: ProjectStatus;
  lastError?: string;
  resourceCount: number;
  referenceCount: number;
  copyCount: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ProjectDirectory {
  relativePath: string;
  name: string;
  depth: number;
  exists: boolean;
  resourceCount: number;
}

export interface ProjectAsset {
  membershipId: number;
  projectId: number;
  sourceAssetUid: string;
  name: string;
  format: string;
  kind: string;
  storageMode: ProjectStorageMode;
  relativeDirectory: string;
  copiedRelativePath?: string;
  status: ProjectAssetStatus;
  effectivePath: string;
  thumbnailPath?: string;
  sizeBytes: number;
  modifiedMs: number;
  sourceChanged: boolean;
}

export interface AssetProjectMembership {
  id: number;
  projectId: number;
  projectName: string;
  projectRootPath: string;
  sourceAssetUid: string;
  storageMode: ProjectStorageMode;
  relativeDirectory: string;
  copiedRelativePath?: string;
  status: ProjectAssetStatus;
  sourceChanged: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ProjectAssetAssignment {
  projectId: number;
  storageMode: ProjectStorageMode;
  relativeDirectory?: string;
}

export function listProjects(query = "") {
  return invoke<Project[]>("list_projects", { query });
}

export function createProject(name: string, parentPath: string) {
  return invoke<Project>("create_project", { name, parentPath });
}

export function renameProject(projectId: number, newName: string) {
  return invoke<Project>("rename_project", { projectId, newName });
}

export function moveProject(projectId: number, newParentPath: string) {
  return invoke<Project>("move_project", { projectId, newParentPath });
}

export function relinkProject(projectId: number, rootPath: string) {
  return invoke<Project>("relink_project", { projectId, rootPath });
}

export function openProjectFolder(projectId: number, relativeDirectory?: string) {
  return invoke<void>("open_project_folder", { projectId, relativeDirectory });
}

export function listProjectDirectories(projectId: number) {
  return invoke<ProjectDirectory[]>("list_project_directories", { projectId });
}

export function createProjectDirectory(projectId: number, parentRelativePath: string, name: string) {
  return invoke<ProjectDirectory[]>("create_project_directory", { projectId, parentRelativePath, name });
}

export function listProjectAssets(projectId: number, relativeDirectory?: string, query = "") {
  return invoke<ProjectAsset[]>("list_project_assets", { projectId, relativeDirectory, query });
}

export function listAssetProjects(assetUid: string) {
  return invoke<AssetProjectMembership[]>("list_asset_projects", { assetUid });
}

export function addAssetToProjects(assetUid: string, assignments: ProjectAssetAssignment[]) {
  return invoke<AssetProjectMembership[]>("add_asset_to_projects", { assetUid, assignments });
}

export function updateProjectAsset(
  membershipId: number,
  storageMode: ProjectStorageMode,
  relativeDirectory: string,
) {
  return invoke<AssetProjectMembership>("update_project_asset", {
    membershipId,
    storageMode,
    relativeDirectory,
  });
}

export function removeAssetFromProject(membershipId: number) {
  return invoke<void>("remove_asset_from_project", { membershipId });
}

export function openProjectAsset(membershipId: number) {
  return invoke<void>("open_project_asset", { membershipId });
}

export function openProjectAssetFolder(membershipId: number) {
  return invoke<void>("open_project_asset_folder", { membershipId });
}
