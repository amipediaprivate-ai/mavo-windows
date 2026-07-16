import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Folder, FolderOpen, Music2, Search } from "lucide-react";
import type { AssetDirectoryTree, DirectoryNode } from "../lib/indexedAssets";

interface AudioDirectoryTreeProps {
  tree?: AssetDirectoryTree;
  loading?: boolean;
  selectedPath?: string;
  onSelect: (path?: string) => void;
}

function collectAncestorPaths(nodes: DirectoryNode[], selectedPath: string, ancestors: string[] = []): string[] | undefined {
  for (const node of nodes) {
    if (node.path === selectedPath) return ancestors;
    const match = collectAncestorPaths(node.children, selectedPath, [...ancestors, node.path]);
    if (match) return match;
  }
  return undefined;
}

function filterDirectoryNodes(nodes: DirectoryNode[], query: string): DirectoryNode[] {
  return nodes.flatMap((node) => {
    const children = filterDirectoryNodes(node.children, query);
    if (node.name.toLocaleLowerCase("zh-CN").includes(query) || node.path.toLocaleLowerCase("zh-CN").includes(query) || children.length > 0) {
      return [{ ...node, children }];
    }
    return [];
  });
}

function DirectoryBranch({
  nodes,
  depth,
  expanded,
  searching,
  selectedPath,
  onToggle,
  onSelect,
}: {
  nodes: DirectoryNode[];
  depth: number;
  expanded: Set<string>;
  searching: boolean;
  selectedPath?: string;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  return nodes.map((node) => {
    const hasChildren = node.children.length > 0;
    const open = searching || expanded.has(node.path);
    const selected = selectedPath === node.path;
    return (
      <div className="directory-node" key={node.path}>
        <div
          className={`directory-row ${selected ? "selected" : ""} ${node.subtreeCount === 0 ? "empty" : ""}`}
          style={{ paddingLeft: `${Math.min(depth * 12, 72)}px` }}
          title={`${node.path}\n当前筛选：${node.subtreeCount.toLocaleString("zh-CN")} 个音频${node.directCount > 0 ? `，本目录 ${node.directCount.toLocaleString("zh-CN")} 个` : ""}`}
        >
          <button
            className="directory-toggle"
            type="button"
            aria-label={hasChildren ? (open ? `收起 ${node.name}` : `展开 ${node.name}`) : undefined}
            disabled={!hasChildren || searching}
            onClick={() => onToggle(node.path)}
          >
            {hasChildren && <ChevronRight size={13} className={open ? "open" : ""} />}
          </button>
          <button className="directory-select" type="button" onClick={() => onSelect(node.path)}>
            {open && hasChildren ? <FolderOpen size={14} /> : <Folder size={14} />}
            <span>{node.name}</span>
          </button>
          <span className="directory-count">{node.subtreeCount.toLocaleString("zh-CN")}</span>
        </div>
        {hasChildren && open && (
          <div className="directory-children">
            <DirectoryBranch
              nodes={node.children}
              depth={depth + 1}
              expanded={expanded}
              searching={searching}
              selectedPath={selectedPath}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          </div>
        )}
      </div>
    );
  });
}

export function AudioDirectoryTree({ tree, loading, selectedPath, onSelect }: AudioDirectoryTreeProps) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visibleRoots = useMemo(
    () => normalizedQuery ? filterDirectoryNodes(tree?.roots ?? [], normalizedQuery) : tree?.roots ?? [],
    [normalizedQuery, tree],
  );

  useEffect(() => {
    if (!tree) return;
    setExpanded((current) => {
      const next = new Set(current);
      tree.roots.forEach((root) => next.add(root.path));
      if (selectedPath) collectAncestorPaths(tree.roots, selectedPath)?.forEach((path) => next.add(path));
      return next;
    });
  }, [selectedPath, tree]);

  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  return (
    <section className="filter-group audio-directory-section">
      <div className="filter-title"><span>按目录查看</span></div>
      <label className="filter-search audio-directory-search">
        <Search size={13} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索目录" aria-label="搜索音频目录" />
      </label>
      <div className="directory-tree" aria-label="音频目录">
        <button className={`directory-all-row ${selectedPath ? "" : "selected"}`} type="button" onClick={() => onSelect(undefined)}>
          <Music2 size={14} />
          <span>全部音频</span>
          <strong>{(tree?.totalCount ?? 0).toLocaleString("zh-CN")}</strong>
        </button>
        {loading && !tree && <span className="filter-empty">正在读取目录…</span>}
        {!loading && tree && tree.roots.length === 0 && <span className="filter-empty">暂无包含音频的目录</span>}
        {tree && tree.roots.length > 0 && normalizedQuery && visibleRoots.length === 0 && <span className="filter-empty">没有匹配的目录</span>}
        <DirectoryBranch
          nodes={visibleRoots}
          depth={0}
          expanded={expanded}
          searching={normalizedQuery.length > 0}
          selectedPath={selectedPath}
          onToggle={toggle}
          onSelect={onSelect}
        />
      </div>
    </section>
  );
}
