"use client";

import { useState, useCallback, useEffect } from "react";
import { toast } from "sonner";
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  File,
  FileCode,
  FileImage,
  FileCog,
  Loader2,
  RefreshCw,
  MoreHorizontal,
  Pencil,
  Trash2,
  Copy,
  Shield,
  PackageOpen,
  Archive,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fetchAPI } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useRefreshAnimation, refreshIconClassName } from "@/hooks/useRefreshAnimation";
import { isArchiveName } from "@/components/files/ArchiveDialogs";
import type { FileNode } from "@vexlyx/shared";

// ---------------------------------------------------------------------------
// File type icon resolver
// ---------------------------------------------------------------------------

const CODE_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "php", "py", "rb", "go", "rs", "java", "cpp", "c", "h", "cs"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp"]);
const CONFIG_EXTENSIONS = new Set(["json", "yaml", "yml", "toml", "ini", "env", "lock", "xml"]);

function FileIcon({ extension, className }: { extension?: string; className?: string }) {
  const ext = extension?.toLowerCase();
  if (!ext) return <File className={cn("h-4 w-4 text-slate-400 shrink-0", className)} />;
  if (CODE_EXTENSIONS.has(ext)) return <FileCode className={cn("h-4 w-4 text-indigo-400 shrink-0", className)} />;
  if (IMAGE_EXTENSIONS.has(ext)) return <FileImage className={cn("h-4 w-4 text-emerald-400 shrink-0", className)} />;
  if (CONFIG_EXTENSIONS.has(ext)) return <FileCog className={cn("h-4 w-4 text-amber-400 shrink-0", className)} />;
  return <File className={cn("h-4 w-4 text-slate-400 shrink-0", className)} />;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface FileTreeProps {
  projectId: string;
  selectedPath?: string;
  onSelect: (node: FileNode) => void;
  onDelete: (node: FileNode) => void;
  onRename: (node: FileNode) => void;
  onPermissions: (node: FileNode) => void;
  onExtract: (node: FileNode) => void;
  onCompress: (node: FileNode) => void;
  /** Ctrl/Cmd+click adds or removes an item from the multi-selection. */
  multiSelectedPaths: Set<string>;
  onToggleMulti: (node: FileNode) => void;
  refreshTrigger?: number;
  className?: string;
}

// ---------------------------------------------------------------------------
// Single tree node
// ---------------------------------------------------------------------------

interface TreeNodeProps {
  node: FileNode;
  projectId: string;
  selectedPath?: string;
  depth: number;
  expandedPaths: Set<string>;
  loadingPaths: Set<string>;
  dirChildren: Map<string, FileNode[]>;
  onToggle: (dirPath: string) => void;
  onSelect: (node: FileNode) => void;
  onDelete: (node: FileNode) => void;
  onRename: (node: FileNode) => void;
  onPermissions: (node: FileNode) => void;
  onExtract: (node: FileNode) => void;
  onCompress: (node: FileNode) => void;
  multiSelectedPaths: Set<string>;
  onToggleMulti: (node: FileNode) => void;
}

function TreeNode({
  node,
  projectId,
  selectedPath,
  depth,
  expandedPaths,
  loadingPaths,
  dirChildren,
  onToggle,
  onSelect,
  onDelete,
  onRename,
  onPermissions,
  onExtract,
  onCompress,
  multiSelectedPaths,
  onToggleMulti,
}: TreeNodeProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const isDir = node.type === "dir";
  const isOpen = isDir && expandedPaths.has(node.path);
  const isLoading = isDir && loadingPaths.has(node.path);
  const isMultiSelected = multiSelectedPaths.has(node.path);
  const isSelected = selectedPath === node.path || isMultiSelected;
  const children = (isDir ? dirChildren.get(node.path) : undefined) ?? node.children ?? [];

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) {
      onToggleMulti(node);
      return;
    }
    if (isDir) {
      onToggle(node.path);
    }
    onSelect(node);
  };

  const handleCopyPath = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsMenuOpen(false);
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(node.path).then(() => {
        toast.success(`Copied: ${node.path}`);
      }).catch(() => {
        toast.info(node.path);
      });
    }
  };

  return (
    <div>
      <div
        className={cn(
          "group flex items-center gap-1.5 rounded-sm px-2 py-1 text-sm cursor-pointer select-none",
          "hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors",
          isSelected && "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 font-medium",
        )}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onClick={handleClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            if (isDir) onToggle(node.path);
            onSelect(node);
          }
        }}
        aria-label={node.name}
      >
        {/* Expand icon (dirs only) */}
        <span
          className="w-3.5 h-3.5 flex items-center justify-center shrink-0"
          onClick={(e) => {
            if (isDir) {
              e.stopPropagation();
              onToggle(node.path);
            }
          }}
        >
          {isDir && (
            isLoading ? (
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
            ) : isOpen ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
            )
          )}
        </span>

        {/* File / folder icon */}
        {isDir ? (
          isOpen ? (
            <FolderOpen className="h-4 w-4 text-amber-400 shrink-0" />
          ) : (
            <Folder className="h-4 w-4 text-amber-400 shrink-0" />
          )
        ) : (
          <FileIcon extension={node.extension} />
        )}

        <span className="truncate flex-1 text-xs">{node.name}</span>

        {/* 3-dot context menu */}
        <DropdownMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
          <DropdownMenuTrigger
            asChild
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "h-5 w-5 shrink-0 transition-opacity",
                isMenuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100",
              )}
              aria-label={`Actions for ${node.name}`}
            >
              <MoreHorizontal className="h-3 w-3 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-48"
            onClick={(e) => e.stopPropagation()}
          >
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                setIsMenuOpen(false);
                onRename(node);
              }}
            >
              <Pencil className="mr-2 h-3.5 w-3.5" /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleCopyPath}>
              <Copy className="mr-2 h-3.5 w-3.5" /> Copy path
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                setIsMenuOpen(false);
                onPermissions(node);
              }}
            >
              <Shield className="mr-2 h-3.5 w-3.5" /> Permissions
            </DropdownMenuItem>
            {!isDir && isArchiveName(node.name) && (
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  setIsMenuOpen(false);
                  onExtract(node);
                }}
              >
                <PackageOpen className="mr-2 h-3.5 w-3.5" /> Extract
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                setIsMenuOpen(false);
                onCompress(node);
              }}
            >
              <Archive className="mr-2 h-3.5 w-3.5" />{" "}
              {isMultiSelected && multiSelectedPaths.size > 1
                ? `Compress ${multiSelectedPaths.size} items`
                : "Compress"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                setIsMenuOpen(false);
                onDelete(node);
              }}
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Children */}
      {isDir && isOpen && children.length > 0 && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              projectId={projectId}
              selectedPath={selectedPath}
              depth={depth + 1}
              expandedPaths={expandedPaths}
              loadingPaths={loadingPaths}
              dirChildren={dirChildren}
              onToggle={onToggle}
              onSelect={onSelect}
              onDelete={onDelete}
              onRename={onRename}
              onPermissions={onPermissions}
              onExtract={onExtract}
              onCompress={onCompress}
              multiSelectedPaths={multiSelectedPaths}
              onToggleMulti={onToggleMulti}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FileTree root
// ---------------------------------------------------------------------------

export function FileTree({
  projectId,
  selectedPath,
  onSelect,
  onDelete,
  onRename,
  onPermissions,
  onExtract,
  onCompress,
  multiSelectedPaths,
  onToggleMulti,
  refreshTrigger = 0,
  className,
}: FileTreeProps) {
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [dirChildren, setDirChildren] = useState<Map<string, FileNode[]>>(new Map());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const { isRefreshing, refresh } = useRefreshAnimation();
  const [error, setError] = useState<string | null>(null);

  // Load children of a specific directory
  const loadDirectory = useCallback(
    async (dirPath: string) => {
      setLoadingPaths((prev) => new Set(prev).add(dirPath));
      try {
        const res = await fetchAPI<{ nodes: FileNode[] }>(
          `/api/files/${projectId}/list?path=${encodeURIComponent(dirPath)}&depth=1`,
        );
        setDirChildren((prev) => {
          const next = new Map(prev);
          next.set(dirPath, res.nodes);
          return next;
        });
        return res.nodes;
      } catch {
        toast.error(`Failed to load ${dirPath || "directory"}`);
        return [];
      } finally {
        setLoadingPaths((prev) => {
          const next = new Set(prev);
          next.delete(dirPath);
          return next;
        });
      }
    },
    [projectId],
  );

  // Refresh tree in-place, preserving expanded folders and fetching their latest children
  const performRefresh = useCallback(
    async (isManual = false) => {
      if (!isManual) setIsLoading(true);
      setError(null);

      try {
        const res = await fetchAPI<{ nodes: FileNode[] }>(
          `/api/files/${projectId}/list?path=&depth=1`,
        );
        setRoots(res.nodes);

        // Re-fetch all currently expanded directories in parallel so their content is fresh
        setExpandedPaths((currentExpanded) => {
          const expandedArray = Array.from(currentExpanded);
          if (expandedArray.length > 0) {
            void Promise.all(
              expandedArray.map(async (dirPath) => {
                try {
                  const childRes = await fetchAPI<{ nodes: FileNode[] }>(
                    `/api/files/${projectId}/list?path=${encodeURIComponent(dirPath)}&depth=1`,
                  );
                  return [dirPath, childRes.nodes] as const;
                } catch {
                  return null;
                }
              }),
            ).then((results) => {
              setDirChildren((prev) => {
                const next = new Map(prev);
                for (const item of results) {
                  if (item) next.set(item[0], item[1]);
                }
                return next;
              });
            });
          }
          return currentExpanded;
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to load files";
        setError(msg);
      } finally {
        setIsLoading(false);
      }
    },
    [projectId],
  );

  const refreshTree = useCallback(
    (isManual = false) => {
      if (isManual) return refresh(() => performRefresh(true));
      return performRefresh(false);
    },
    [performRefresh, refresh],
  );

  // Initial load
  useEffect(() => {
    void refreshTree(false);
  }, [projectId]);

  // React to refreshTrigger changes
  useEffect(() => {
    if (refreshTrigger > 0) {
      void refreshTree(true);
    }
  }, [refreshTrigger]);

  // Auto-expand all ancestor directories of selectedPath so the active file is visible
  useEffect(() => {
    if (!selectedPath) return;
    const parts = selectedPath.split("/").filter(Boolean);
    parts.pop(); // discard filename
    if (parts.length === 0) return;

    const ancestors: string[] = [];
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      ancestors.push(current);
    }

    setExpandedPaths((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const anc of ancestors) {
        if (!next.has(anc)) {
          next.add(anc);
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    // Ensure children are loaded for any ancestor not yet in cache
    for (const anc of ancestors) {
      if (!dirChildren.has(anc)) {
        void loadDirectory(anc);
      }
    }
  }, [selectedPath, dirChildren, loadDirectory]);

  // Toggle folder open / close
  const handleToggle = useCallback(
    (dirPath: string) => {
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(dirPath)) {
          next.delete(dirPath);
        } else {
          next.add(dirPath);
          if (!dirChildren.has(dirPath)) {
            void loadDirectory(dirPath);
          }
        }
        return next;
      });
    },
    [dirChildren, loadDirectory],
  );

  if (isLoading) {
    return (
      <div className={cn("flex items-center justify-center h-32 text-muted-foreground", className)}>
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        <span className="text-xs">Loading files…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn("px-3 py-6 text-center space-y-2", className)}>
        <p className="text-xs text-rose-500">{error}</p>
        <Button variant="outline" size="sm" onClick={() => void refreshTree(true)}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className={cn("select-none text-xs", className)}>
      <div className="flex items-center justify-between px-2 py-1 mb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
          Explorer
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 text-muted-foreground hover:text-foreground"
          onClick={() => void refreshTree(true)}
          aria-label="Refresh file tree"
          title="Refresh tree"
        >
          <RefreshCw className={refreshIconClassName(isRefreshing, "h-3 w-3")} />
        </Button>
      </div>

      {roots.length === 0 ? (
        <div className="px-3 py-4 text-xs text-muted-foreground text-center">
          No files in this project yet
        </div>
      ) : (
        roots.map((node) => (
          <TreeNode
            key={node.path}
            node={node}
            projectId={projectId}
            selectedPath={selectedPath}
            depth={0}
            expandedPaths={expandedPaths}
            loadingPaths={loadingPaths}
            dirChildren={dirChildren}
            onToggle={handleToggle}
            onSelect={onSelect}
            onDelete={onDelete}
            onRename={onRename}
            onPermissions={onPermissions}
            onExtract={onExtract}
            onCompress={onCompress}
            multiSelectedPaths={multiSelectedPaths}
            onToggleMulti={onToggleMulti}
          />
        ))
      )}
    </div>
  );
}
