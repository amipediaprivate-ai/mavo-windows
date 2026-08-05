# Mavo 项目模块需求与技术设计说明

> 文档状态：开发基线
> 适用平台：Mavo Windows Desktop
> 文档版本：1.0
> 更新日期：2026-08-05

## 1. 文档目标

本文档定义 Mavo“项目”模块的产品范围、业务规则、交互流程、数据模型、文件系统行为、前后端接口、异常恢复机制与验收标准。本文档作为项目模块的设计与开发基线，所有实现与测试均以本文档为准。

## 2. 背景与目标

Mavo 当前以本地资产索引为核心，资源原文件分散在用户磁盘的不同位置。项目模块在现有资产库之上增加项目级组织能力，使用户能够：

1. 创建和管理以磁盘文件夹为实体的项目。
2. 将同一个交付任务使用的资源统一归类到一个项目。
3. 在不改变资源原始位置的情况下，通过“标记”方式建立项目索引。
4. 通过“复制”方式，将资源副本实际放入项目文件夹。
5. 将同一资源同时归属到多个项目，并为每个项目独立设置存在方式与子目录。
6. 在 Mavo 内或 Windows 文件资源管理器中管理项目子文件夹。

## 3. 核心概念

### 3.1 项目

项目由一条 Mavo 数据记录和一个本地磁盘根文件夹共同构成。项目名称与根文件夹名称始终一致。

项目包含以下核心属性：

| 属性 | 含义 |
| --- | --- |
| 项目 ID | Mavo 内部稳定标识，项目重命名或迁移后不改变 |
| 项目名称 | 用户可见名称，同时作为项目根文件夹名称 |
| 所在位置 | 项目根文件夹的父目录 |
| 项目路径 | `所在位置\项目名称` 形成的绝对路径 |
| 状态 | 正常、文件夹缺失、迁移中、操作失败 |
| 创建时间 | 项目创建时间 |
| 更新时间 | 项目最后一次配置变更时间 |

### 3.2 项目资源

项目资源是“资产库资源”与“项目”之间的归属关系。同一资源在同一项目中只存在一条归属关系，同一资源可以同时属于多个项目。

每条归属关系独立保存：

- 存在方式：标记或复制。
- 所属子目录：相对于项目根文件夹的路径。
- 源资源快照：名称、类型、格式、原路径等，用于源索引缺失后的展示与恢复。
- 副本信息：仅复制方式使用，记录项目副本的稳定资源标识、相对路径和复制时源文件状态。

### 3.3 标记

标记只在 Mavo 数据库中建立项目索引，不移动、不复制、不修改资源原文件。

- 项目界面按所选子目录展示该资源。
- Windows 文件资源管理器中的项目目录不会出现该资源文件。
- 打开原文件或所在文件夹时，目标始终是资产库中的原文件。
- 原文件移动后，现有资产重新定位机制继续通过稳定的 `asset_uid` 维持项目关系。
- 原文件缺失后，项目关系保留并显示“原文件缺失”。

### 3.4 复制

复制会在项目子目录中创建一份独立的文件副本。

- 项目界面使用项目副本进行预览、播放和打开操作。
- 资产库中的原文件不移动、不修改。
- 副本是创建时的快照，源文件后续变化不会自动覆盖项目副本。
- 系统记录复制时源文件的大小、修改时间与内容哈希，用于识别源文件更新和副本异常。
- 项目副本属于“项目专属资产”，不会作为新的普通资产出现在全局资产列表和重复文件结果中。
- 项目副本被外部删除后，项目关系保留并显示“项目副本缺失”。

## 4. 功能范围

### 4.1 项目列表

用户进入顶部“项目”导航后，看到自己的全部项目。

列表项展示：

- 项目名称。
- 项目完整路径。
- 项目资源总数。
- 标记资源数量。
- 复制资源数量。
- 文件夹状态。
- 最后更新时间。

项目列表支持：

- 按名称搜索。
- 按最后更新时间倒序排列。
- 打开项目。
- 打开项目文件夹。
- 重命名项目。
- 调整项目所在位置。
- 新建项目。

### 4.2 创建项目

创建项目表单包含：

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| 项目名称 | 是 | 去除首尾空格后为 1～100 个字符；符合 Windows 文件夹命名规则 |
| 所在位置 | 是 | 已存在、可写的绝对父目录 |
| 项目路径 | 自动 | 实时显示为 `所在位置\项目名称`，不可直接编辑 |

提交创建时按以下顺序执行：

1. 校验项目名称、父目录权限和目标路径冲突。
2. 创建项目根文件夹。
3. 在项目根目录内创建 `image`、`audio`、`video`、`gif` 四个默认子文件夹。
4. 在同一个数据库事务中写入项目记录。
5. 创建失败时删除本次操作新建且仍为空的目录，不改动创建前已经存在的任何文件或目录。
6. 创建完成后进入项目详情页。

目标项目路径必须不存在。项目名称在 Mavo 内按大小写不敏感规则保持唯一。

### 4.3 项目重命名

重命名同时修改项目名称和磁盘根文件夹名称，项目 ID 不变。

执行规则：

1. 新名称通过与创建项目相同的校验。
2. 项目内没有未完成的复制、移动或删除操作。
3. 同级目录下不存在新名称对应的文件或文件夹。
4. 通过原生文件系统操作重命名项目根文件夹。
5. 在数据库事务中更新项目路径、路径规范键以及全部项目专属资产路径。
6. 操作期间项目状态为“迁移中”，项目写操作暂时禁用。
7. 任一步骤失败时进入可恢复状态，不产生两条项目记录。

### 4.4 调整项目所在位置

调整位置会把整个项目根文件夹迁移到新的父目录，项目名称和项目 ID 不变。

执行规则：

- 新父目录必须存在且可写。
- 目标路径固定为 `新父目录\当前项目名称`，且必须不存在。
- 同一磁盘分区内使用原生目录重命名完成迁移。
- 跨磁盘分区时，先复制整个目录到迁移临时目录，完成文件数量、文件大小与哈希校验后，再切换为正式目录并将旧目录移入回收站。
- 项目中的自定义文件、空文件夹、标记关系和项目副本全部保留。
- 数据库中的项目根路径、项目专属资产路径、目录路径与全文检索数据同步更新。
- 迁移期间禁止添加资源、切换存在方式、调整子目录、创建子文件夹和再次迁移。

### 4.5 项目详情

项目详情页由以下区域组成：

1. 顶部栏：项目名称、完整路径、资源统计、打开项目文件夹、重命名、调整位置。
2. 左侧目录树：项目根目录、默认目录和用户创建的子目录。
3. 中部资源区：当前目录下的项目资源，沿用资产模块的网格、瀑布流和列表展示能力。
4. 右侧资源明细：预览、基础信息、存在方式、所属子目录、源文件状态、项目副本状态。

目录树同时合并以下信息：

- 项目磁盘根目录下实际存在的目录。
- 项目资源关系中记录但已在磁盘上缺失的逻辑目录。

缺失目录以不可用状态显示。目录扫描不跟随 Windows 重解析点、目录联接或符号链接，所有 Mavo 写操作必须保持在项目根目录内。

### 4.6 创建项目子文件夹

用户可以通过两种方式创建子文件夹：

- 在 Mavo 项目详情中选择父目录并创建。
- 打开项目文件夹，在 Windows 文件资源管理器中自行创建。

Mavo 内创建时：

- 文件夹名称必须符合 Windows 命名规则。
- 同一父目录内按大小写不敏感规则禁止重名。
- 支持多级目录，目录相对路径不得包含 `.`、`..`、绝对路径前缀或盘符。
- 创建成功后立即刷新目录树。

在文件资源管理器中创建、重命名或删除目录后，Mavo 通过文件监听更新目录树；重新进入项目时执行一次完整目录同步，确保离线期间的变化被识别。

### 4.7 资产明细中的“所属项目”

资产模块右侧“资源明细”新增“所属项目”区块，位于“所属文件夹”与“标签”之间。

区块展示当前资源的全部项目关系。每一行包含：

- 项目名称。
- 存在方式徽标与切换控件。
- 所属子目录。
- 当前状态。
- 打开项目操作。
- 从项目移除操作。

区块底部提供“添加到项目”入口。添加面板包含项目选择、存在方式与所属子目录三个字段。一次操作可以选择多个项目，每个项目生成独立归属关系；已归属的项目不可重复选择。

### 4.8 默认子目录

添加资源到项目时，按资源类型自动选中默认子目录：

| Mavo 资源类型 | 默认项目子目录 |
| --- | --- |
| 图片 | `image` |
| 音频 | `audio` |
| 视频 | `video` |
| 动图 | `gif` |
| 设计文件 | 项目根目录 |
| 3D 模型 | 项目根目录 |
| 字体 | 项目根目录 |
| 文档 | 项目根目录 |

默认目录被用户从磁盘删除后，再次向该目录添加资源时由 Mavo 重新创建。

### 4.9 添加资源到项目

#### 标记方式

1. 校验项目与目标子目录状态。
2. 写入项目资源关系和源资源快照。
3. 不执行文件复制。
4. 刷新资产明细和项目资源计数。

#### 复制方式

1. 校验源资源可用、项目可写、磁盘剩余空间和目标目录状态。
2. 在目标目录创建不被资产扫描器识别的临时文件。
3. 采用流式复制，避免将完整文件载入内存。
4. 校验目标文件大小与内容哈希。
5. 将临时文件原子重命名为最终文件名。
6. 创建项目专属资产索引和项目资源关系。
7. 刷新项目资源、缩略图和后台任务状态。

目标目录存在同名文件时，Mavo 保留原扩展名并生成 `名称 (2).扩展名`、`名称 (3).扩展名`，直至得到未占用名称。任何既有文件都不会被覆盖。

### 4.10 快捷切换存在方式

#### 标记切换为复制

- 使用当前所属子目录作为复制目标。
- 目标目录缺失时先创建目录。
- 完成副本复制和校验后，将关系切换为“复制”。
- 复制失败时继续保持“标记”，不留下正式目标文件。

#### 复制切换为标记

- 界面明确显示“项目副本将移入回收站，资产库原文件不受影响”。
- 用户确认后，将项目副本移入 Windows 回收站。
- 清理项目专属资产索引、缩略图缓存和副本字段。
- 保留同一条项目关系并切换为“标记”。
- 移入回收站失败时不切换关系。

### 4.11 调整所属子目录

- 标记方式：只更新项目资源关系中的相对目录，不移动原文件。
- 复制方式：将项目副本移动到新的项目子目录，并同步更新项目专属资产路径和缩略图引用。
- 目标目录不存在时先创建。
- 目标位置存在同名文件时按同名冲突规则生成新名称。
- 文件移动完成前，数据库继续保留旧目录；失败时项目资源仍指向旧副本。

### 4.12 从项目移除

- 标记方式：删除项目资源关系，不操作原文件。
- 复制方式：确认后将项目副本移入回收站，再清理项目资源关系、项目专属索引与缓存。
- 从一个项目移除不影响该资源在其他项目中的关系。
- 从项目移除不删除资产库中的源资源记录。

## 5. 业务规则

### 5.1 唯一性

- 项目名称按大小写不敏感规则全局唯一。
- 项目规范化根路径全局唯一。
- 同一 `source_asset_uid` 在同一项目内只有一条关系。
- 项目专属副本拥有独立 `asset_uid`，并通过 `origin_asset_uid` 追溯源资源。

### 5.2 路径安全

- 数据库存储绝对展示路径和规范化路径键。
- Windows 路径键执行绝对化、分隔符统一、冗余段消除与大小写折叠。
- 所有子目录均以相对路径存储。
- 每次写操作前重新拼接并校验目标路径仍位于项目根目录之下。
- 拒绝 Windows 保留名称、控制字符、尾随空格、尾随句点和非法字符 `< > : " / \\ | ? *`。
- 不跟随重解析点执行复制、移动、删除或递归统计。

### 5.3 源资源与副本状态

| 场景 | 标记资源 | 复制资源 |
| --- | --- | --- |
| 源文件正常 | 正常 | 项目副本正常 |
| 源文件缺失 | 显示“原文件缺失” | 副本仍可正常使用，同时显示源文件缺失 |
| 源文件更新 | 自动读取最新原文件 | 副本不变，显示“源文件有更新” |
| 项目副本缺失 | 不适用 | 显示“项目副本缺失”，保留关系 |
| 项目根目录缺失 | 项目不可用，关系保留 | 项目不可用，关系保留 |

### 5.4 文件所有权

Mavo 只自动删除或移入回收站由项目复制流程创建且仍由项目关系管理的文件。用户自行放入项目目录的文件、未知文件和自定义目录不会被清理。

## 6. 交互状态与反馈

所有文件操作在 Mavo 前端内显示进度、结果和错误，不打开命令行或控制台窗口。

### 6.1 状态定义

| 状态 | 前端行为 |
| --- | --- |
| `ready` | 正常操作 |
| `missing` | 显示路径缺失，可重新定位项目 |
| `moving` | 显示迁移进度，禁用项目写操作 |
| `error` | 显示最近错误和恢复操作 |
| `copying` | 单条资源显示复制进度，禁止重复提交 |
| `copy_missing` | 显示副本缺失，可重新复制或切换为标记 |
| `source_missing` | 禁用新增复制，允许保留或新增标记 |

### 6.2 操作反馈

- 小文件操作完成后使用现有 Toast 提示。
- 复制、跨盘迁移和批量操作进入现有“后台任务”面板。
- 错误信息包含对象名称、失败阶段和可理解的原因，不显示 Rust 堆栈或原始 SQL。
- 同一操作只允许一个进行中实例，重复点击不会重复复制。

## 7. 技术架构

### 7.1 现有架构接入

项目模块沿用现有技术栈：

- 前端：React 19 + TypeScript + Vite。
- 桌面容器：Tauri 2。
- 本地服务：Rust Tauri commands。
- 持久化：现有 `mavo-index.sqlite3`，WAL 模式。
- 文件选择：`@tauri-apps/plugin-dialog`。
- 资源预览与播放：现有缩略图、`mavo-media` 协议和媒体分析链路。

代码职责划分：

| 层级 | 文件/模块 | 职责 |
| --- | --- | --- |
| 页面状态 | `src/App.tsx` | 顶部导航增加“项目”，在资产与项目工作区之间切换 |
| 项目工作区 | `src/components/ProjectWorkspace.tsx` | 项目列表、项目详情和路由状态 |
| 项目组件 | `src/components/projects/*` | 创建、重命名、迁移、目录树、资源列表、归属编辑 |
| 前端数据访问 | `src/lib/projects.ts` | 类型定义、Tauri invoke 封装、返回值转换 |
| 资产明细 | `src/components/DetailPanel.tsx` | 新增“所属项目”区块和快捷编辑入口 |
| Rust 领域服务 | `src-tauri/src/projects.rs` | 项目、目录、归属关系和恢复逻辑 |
| Rust 文件服务 | `src-tauri/src/project_files.rs` | 复制、移动、哈希、回收站和路径边界校验 |
| 数据迁移 | `src-tauri/src/lib.rs` | 初始化项目表、索引和 `indexed_assets` 扩展字段 |

### 7.2 前端导航改造

当前 `AppHeader` 已显示“项目”入口，但 `activeSection` 仅支持“资产”和“工具”，点击项目只显示占位消息。实现时执行以下改造：

```ts
export type AppSection = "资产" | "项目" | "工具";
```

- `AppHeaderProps.activeSection` 与 `onSectionChange` 使用 `AppSection`。
- 点击“项目”直接切换到 `ProjectWorkspace`。
- 搜索框在项目列表页搜索项目名称，在项目详情页搜索当前项目资源。
- 资产模块与项目模块分别保存最后一次视图、筛选和选中状态。

### 7.3 数据模型

#### 7.3.1 `projects`

```sql
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  parent_path TEXT NOT NULL,
  root_path TEXT NOT NULL,
  root_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'ready'
    CHECK (status IN ('ready', 'missing', 'moving', 'error')),
  last_error TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS projects_updated_idx
  ON projects(updated_at_ms DESC, id DESC);
```

#### 7.3.2 `project_assets`

```sql
CREATE TABLE IF NOT EXISTS project_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  source_asset_uid TEXT NOT NULL,
  storage_mode TEXT NOT NULL
    CHECK (storage_mode IN ('reference', 'copy')),
  relative_directory TEXT NOT NULL DEFAULT '',
  materialized_asset_uid TEXT,
  copied_relative_path TEXT,
  source_name_snapshot TEXT NOT NULL,
  source_kind_snapshot TEXT NOT NULL,
  source_format_snapshot TEXT NOT NULL,
  source_path_snapshot TEXT NOT NULL,
  source_size_at_copy INTEGER,
  source_modified_at_copy INTEGER,
  source_hash_at_copy TEXT,
  status TEXT NOT NULL DEFAULT 'ready'
    CHECK (status IN ('ready', 'source_missing', 'copy_missing', 'copying', 'error')),
  last_error TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(project_id, source_asset_uid),
  CHECK (
    (storage_mode = 'reference' AND materialized_asset_uid IS NULL AND copied_relative_path IS NULL)
    OR
    (storage_mode = 'copy' AND materialized_asset_uid IS NOT NULL AND copied_relative_path IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS project_assets_project_directory_idx
  ON project_assets(project_id, relative_directory, updated_at_ms DESC);

CREATE INDEX IF NOT EXISTS project_assets_source_idx
  ON project_assets(source_asset_uid, project_id);

CREATE UNIQUE INDEX IF NOT EXISTS project_assets_materialized_idx
  ON project_assets(materialized_asset_uid)
  WHERE materialized_asset_uid IS NOT NULL;
```

#### 7.3.3 `project_file_operations`

该表是数据库与文件系统之间的持久化操作日志，用于应用异常退出后的恢复。

```sql
CREATE TABLE IF NOT EXISTS project_file_operations (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  project_asset_id INTEGER,
  operation_type TEXT NOT NULL
    CHECK (operation_type IN ('copy', 'move_copy', 'delete_copy', 'rename_project', 'move_project')),
  source_path TEXT,
  target_path TEXT,
  temp_path TEXT,
  state TEXT NOT NULL
    CHECK (state IN ('prepared', 'files_done', 'db_done', 'failed')),
  error_message TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS project_file_operations_state_idx
  ON project_file_operations(state, updated_at_ms);
```

#### 7.3.4 扩展 `indexed_assets`

```sql
ALTER TABLE indexed_assets
  ADD COLUMN asset_scope TEXT NOT NULL DEFAULT 'library';

ALTER TABLE indexed_assets
  ADD COLUMN origin_asset_uid TEXT;

CREATE INDEX IF NOT EXISTS indexed_assets_project_scope_idx
  ON indexed_assets(origin_asset_uid, availability)
  WHERE asset_scope = 'project';
```

字段约束由迁移代码和写入服务统一保证：

- 普通资产：`asset_scope = 'library'`，`origin_asset_uid IS NULL`。
- 项目副本：`asset_scope = 'project'`，`origin_asset_uid = source_asset_uid`。
- 全局资产列表、筛选统计、目录树、重复文件扫描和智能视图固定包含 `asset_scope = 'library'` 条件。
- 项目详情通过 `project_assets` 关联源资产或项目专属资产，不依赖全局资产查询。

### 7.4 前端数据类型

```ts
export type ProjectStatus = "ready" | "missing" | "moving" | "error";
export type ProjectStorageMode = "reference" | "copy";
export type ProjectAssetStatus =
  | "ready"
  | "source_missing"
  | "copy_missing"
  | "copying"
  | "error";

export interface Project {
  id: number;
  name: string;
  parentPath: string;
  rootPath: string;
  status: ProjectStatus;
  resourceCount: number;
  referenceCount: number;
  copyCount: number;
  createdAtMs: number;
  updatedAtMs: number;
  lastError?: string;
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
```

### 7.5 Tauri 命令接口

| 命令 | 输入 | 输出 | 说明 |
| --- | --- | --- | --- |
| `list_projects` | 搜索词、分页 | `ProjectPage` | 查询项目及统计 |
| `create_project` | 名称、父路径 | `Project` | 创建根目录、默认目录和记录 |
| `rename_project` | 项目 ID、新名称 | `Project` | 重命名根目录并更新全部路径 |
| `move_project` | 项目 ID、新父路径 | `BackgroundTask` | 迁移整个项目 |
| `relink_project` | 项目 ID、现有根路径 | `Project` | 项目文件夹缺失时重新定位 |
| `open_project_folder` | 项目 ID、可选相对目录 | `void` | 使用资源管理器打开项目目录 |
| `list_project_directories` | 项目 ID | `ProjectDirectoryTree` | 扫描并返回目录树 |
| `create_project_directory` | 项目 ID、父相对路径、名称 | `ProjectDirectory` | 创建子文件夹 |
| `list_project_assets` | 项目 ID、目录、搜索、分页、排序 | `ProjectAssetPage` | 查询项目资源 |
| `list_asset_projects` | `asset_uid` | `AssetProjectMembership[]` | 查询资源所属全部项目 |
| `add_asset_to_projects` | `asset_uid`、项目配置数组 | `AssetProjectMembership[]` | 添加到一个或多个项目 |
| `update_project_asset` | 关系 ID、存在方式、相对目录 | `AssetProjectMembership` | 切换方式或移动子目录 |
| `remove_asset_from_project` | 关系 ID | `void` | 删除关系并处理副本 |

所有写命令在 Rust 端重复执行完整校验。前端校验只用于即时反馈，不构成安全边界。

### 7.6 文件操作实现

#### 7.6.1 无控制台约束

- 复制、移动、创建目录、哈希和路径校验全部使用 Rust 标准文件系统 API 与现有库完成。
- 将文件移入回收站使用 Rust `trash` 库调用 Windows Shell 能力。
- 打开项目目录复用现有 `windowless_command("explorer.exe")`，保持 `CREATE_NO_WINDOW`。
- 禁止通过 `cmd.exe`、PowerShell、`robocopy`、`xcopy` 或外部终端执行项目文件操作。
- 所有进度、日志与错误仅显示在 Mavo 前端和后台任务面板。

#### 7.6.2 复制一致性

复制操作采用“操作日志 + 临时文件 + 校验 + 数据库提交”流程：

1. 写入 `project_file_operations(state = 'prepared')`。
2. 复制到目标目录中的 `.mavo-copy-{operation_id}.part`。
3. 每次读取固定大小缓冲区并更新进度与 BLAKE3 哈希。
4. 调用 `sync_all` 后校验长度和哈希。
5. 将临时文件原子重命名为最终名称，操作日志进入 `files_done`。
6. 在 `BEGIN IMMEDIATE` 事务中写入项目专属 `indexed_assets` 和 `project_assets`，操作日志进入 `db_done`。
7. 提交后删除完成的操作日志。

复制临时文件扩展名为 `.part`，不会进入资产扫描器。事务失败时删除本次创建的最终文件；删除失败时保留操作日志，由启动恢复流程清理。

#### 7.6.3 项目迁移一致性

- 迁移前把项目状态设置为 `moving` 并持久化操作日志。
- 暂停该项目根目录的文件监听写回。
- 文件系统阶段完成后，按旧根路径前缀批量更新 `projects`、项目专属 `indexed_assets`、目录缓存和 FTS 数据。
- 数据库提交成功后重新注册新根目录监听并设置项目状态为 `ready`。
- 应用启动时扫描未完成操作日志，根据旧路径、目标路径和临时路径的实际状态继续完成或安全回滚。
- 恢复流程不覆盖任何未知目标文件。

### 7.7 扫描与监听

- 项目专属副本仍写入 `indexed_assets`，复用现有元数据分析、缩略图和媒体播放能力。
- 普通资产扫描器遇到 `project_assets.copied_relative_path` 对应文件时，不创建第二条普通资产记录。
- 文件监听发现项目副本变化时，更新项目专属索引并标记副本已修改。
- 文件监听发现项目副本删除时，将项目关系标记为 `copy_missing`，不删除关系。
- 文件监听发现项目目录变化时，只刷新对应项目的目录树缓存。
- 对项目目录的监听事件执行去抖和路径归并，沿用现有后台任务机制。

### 7.8 并发控制

- 每个项目使用一个异步互斥锁，迁移与重命名持有项目独占锁。
- 每条项目资源关系使用独立互斥锁，防止重复复制、移动和切换方式。
- 锁只存在于进程内；跨崩溃一致性由 `project_file_operations` 保证。
- SQLite 写入继续使用 `busy_timeout(5s)` 和短事务，文件复制过程不持有数据库事务。

## 8. 异常处理

| 异常 | 系统行为 |
| --- | --- |
| 项目根目录被外部删除或移动 | 项目标记为 `missing`，保留全部关系，提供重新定位 |
| 默认目录被删除 | 目录树反映缺失；下次向该类型目录添加资源时重建 |
| 源文件在复制前缺失 | 拒绝复制，关系不变 |
| 复制中磁盘空间不足 | 删除临时文件，记录失败原因，关系不变 |
| 复制中应用退出 | 启动时根据操作日志清理临时文件或完成数据库写入 |
| 项目副本被外部删除 | 标记 `copy_missing`，保留源关系和展示快照 |
| 项目副本被外部改名 | 在同一项目根目录内通过项目专属 `asset_uid`、文件标识与监听事件更新路径 |
| 项目副本被移出项目根目录 | 标记 `copy_missing`，不追踪项目外位置 |
| 重命名目标已存在 | 拒绝操作，不覆盖目标 |
| 项目跨盘迁移校验失败 | 删除迁移临时目录，继续使用旧项目目录 |
| 数据库繁忙 | 等待现有 5 秒超时后返回明确错误，不重复执行文件操作 |
| 无权限访问项目目录 | 项目标记错误，保留记录和关系 |

## 9. 性能要求

- 项目列表与项目资源列表均使用数据库分页，单页默认 100 条。
- 10 万条项目资源关系下，按项目和目录查询不执行全表扫描。
- 项目列表首屏数据库查询在本机缓存热态下完成时间不超过 200 ms。
- 目录扫描在后台执行，先展示上次结果，再增量刷新。
- 文件复制采用 1 MiB～8 MiB 固定缓冲区，内存占用不随文件大小增长。
- 大于 50 MiB 的复制操作与所有跨盘项目迁移显示确定性进度。
- 项目资源的缩略图、音视频元数据沿用现有后台分析队列，不阻塞页面交互。

## 10. 测试范围

### 10.1 Rust 单元测试

- Windows 项目名称与相对路径校验。
- 路径规范化和根目录包含关系校验。
- 默认目录映射。
- 同名文件序号生成。
- 项目表迁移幂等性。
- 同项目重复添加约束。
- 标记与复制关系字段约束。
- 全局资产查询排除 `asset_scope = 'project'`。
- 操作日志在各状态下的恢复分支。

### 10.2 Rust 集成测试

- 创建项目同时创建四个默认目录。
- 重命名项目后项目 ID 不变，全部副本路径更新。
- 同盘和跨盘迁移成功与失败回滚。
- 复制资源后源文件与副本内容一致。
- 标记切换复制、复制切换标记。
- 复制资源调整子目录。
- 删除源文件后标记和复制资源状态正确。
- 删除副本后关系保留且状态为 `copy_missing`。
- 应用在 `prepared`、`files_done`、`db_done` 阶段退出后的恢复。
- 所有 Windows 子进程调用均经过 `windowless_command`，运行时不出现控制台窗口。

### 10.3 前端组件测试

- 项目导航切换与状态保留。
- 创建项目字段校验和提交状态。
- 项目列表空态、加载态、错误态和缺失态。
- 资产明细所属项目的加载、添加、切换目录、切换方式和移除。
- 项目目录树对外部目录变化的刷新。
- 长路径、长项目名和错误文本的布局。
- 复制与迁移期间按钮禁用和进度显示。

### 10.4 桌面端验收测试

- 使用安装构建产物验证项目创建、复制、播放、迁移、回收站和文件资源管理器打开行为。
- 在 NTFS 同盘、不同盘符、只读目录、磁盘空间不足和长路径环境下验证。
- 在项目文件夹和源文件夹同时被 Windows 文件资源管理器操作时验证监听一致性。
- 全流程确认不打开、闪现或暴露任何系统命令行与控制台窗口。

## 11. 验收标准

1. 顶部“项目”入口可进入项目模块，并展示当前用户的全部项目。
2. 用户可输入名称和所在位置创建项目，磁盘上生成同名根文件夹及 `image`、`audio`、`video`、`gif` 四个目录。
3. 用户可重命名项目，项目记录与磁盘根文件夹名称同步变化。
4. 用户可调整项目所在位置，整个项目目录完整迁移且项目 ID 不变。
5. 用户可在 Mavo 内创建任意层级项目子文件夹。
6. 用户在文件资源管理器中创建的项目子文件夹会出现在 Mavo 目录树中。
7. 资产明细展示“所属项目”，支持将资源添加到一个或多个项目。
8. 每个项目关系可独立选择标记或复制，并可在添加后快捷切换。
9. 标记方式不改变磁盘原文件，项目界面能够按指定子目录展示。
10. 复制方式在项目子目录生成内容一致的副本，不覆盖任何同名文件。
11. 用户可调整资源所属子目录；标记只更新索引，复制会移动项目副本。
12. 图片、音频、视频、动图分别默认选择 `image`、`audio`、`video`、`gif`。
13. 项目副本不会作为普通资产重复出现在全局资产列表和重复文件视图中。
14. 源文件或项目副本缺失后关系不会静默丢失，界面显示准确状态。
15. 文件操作中断后再次启动 Mavo 能恢复到一致状态，不覆盖用户既有文件。
16. 项目相关操作全程在 Mavo 界面内反馈，Windows 运行时不出现控制台窗口。
17. 完整桌面构建、Rust 测试、前端类型检查和关键桌面验收全部通过。

## 12. 本期边界

本期不包含以下能力：

- 云端项目、团队协作、项目分享与权限控制。
- 源文件与项目副本之间的自动双向同步。
- 项目模板和自定义默认目录规则。
- 项目压缩、导出、打包和版本管理。
- 同一源资源在同一项目内出现多次。
- 自动把用户手动放入项目目录的未知文件注册为项目资源。
- 删除整个项目及其磁盘文件。

用户手动放入项目目录的文件保持原样，Mavo 不覆盖、不移动、不清理。
