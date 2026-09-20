/**
 * YggdrasilToolbar — filters (staged), search, legend, descendant toggle, and refresh controls.
 */

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search,
  Filter,
  RefreshCw,
  X,
  ZoomIn,
  ZoomOut,
  Maximize,
  Info,
  GitFork,
  Check,
  RotateCcw,
  Trees,
  Network,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { TreeNode } from "./use-tree-layout";

export type StatusFilter = "in_sync" | "behind" | "failed";

/**
 * Which drawing of the fleet is on screen.
 *
 * Two views, not a replacement. The canopy is what the fleet LOOKS like — a
 * limb's girth is what it carries, a bare branch is a clone whose sync failed —
 * and it answers "how is the fleet" before you have read a word. The diagram is
 * what you work in: range-select a run of siblings, compare a handful, read a
 * label without rotating anything. Dropping either would take a capability away
 * to gain a look.
 */
export type TreeView = "canopy" | "diagram";

interface Props {
  activeFilters: StatusFilter[];
  onFiltersChange: (filters: StatusFilter[]) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  searchResults: { id: string; name: string; repo: string }[];
  onSearchSelect: (id: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  selectedNode?: TreeNode | null;
  descendantFilterEnabled?: boolean;
  onDescendantFilterToggle?: (enabled: boolean) => void;
  hasUncommittedChanges?: boolean;
  onApplyFilters?: () => void;
  onClearFilters?: () => void;
  multiSelectCount?: number;
  onClearSelection?: () => void;
  view?: TreeView;
  onViewChange?: (view: TreeView) => void;
  /** Set when WebGL could not start, so the canopy is offered as unavailable. */
  canopyUnavailable?: string | null;
}

const STATUS_OPTIONS: {
  value: StatusFilter;
  label: string;
  color: string;
  description: string;
}[] = [
  {
    value: "in_sync",
    label: "In Sync",
    color: "oklch(0.78 0.18 150)",
    description:
      "Clone is up-to-date with the prime repository. All commits have been successfully cascaded.",
  },
  {
    value: "behind",
    label: "Behind",
    color: "oklch(0.82 0.17 80)",
    description:
      "Clone is missing recent commits from the prime. A cascade is needed to bring it current.",
  },
  {
    value: "failed",
    label: "Failed",
    color: "oklch(0.66 0.24 25)",
    description:
      "Last cascade attempt failed due to merge conflicts or CI errors. Manual intervention required.",
  },
];

/** Count descendants recursively by status */
function countDescendantsByStatus(node: TreeNode): Record<string, number> {
  const counts: Record<string, number> = {};
  function walk(n: TreeNode) {
    for (const child of n.children) {
      counts[child.syncStatus] = (counts[child.syncStatus] ?? 0) + 1;
      walk(child);
    }
  }
  walk(node);
  return counts;
}

export function YggdrasilToolbar({
  activeFilters,
  onFiltersChange,
  searchQuery,
  onSearchChange,
  searchResults,
  onSearchSelect,
  onRefresh,
  refreshing,
  zoom,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  selectedNode,
  descendantFilterEnabled,
  onDescendantFilterToggle,
  hasUncommittedChanges,
  onApplyFilters,
  onClearFilters,
  multiSelectCount,
  onClearSelection,
  view = "diagram",
  onViewChange,
  canopyUnavailable = null,
}: Props) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [legendHovered, setLegendHovered] = useState<StatusFilter | null>(null);
  const searchRef = useRef<HTMLDivElement>(null);

  const toggleFilter = (f: StatusFilter) => {
    onFiltersChange(
      activeFilters.includes(f) ? activeFilters.filter((x) => x !== f) : [...activeFilters, f],
    );
  };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const showDescendantToggle =
    selectedNode && selectedNode.id !== "__trunk__" && selectedNode.children.length > 0;

  // Count descendants by status for contextual tooltip
  const descendantCounts =
    selectedNode && selectedNode.id !== "__trunk__" ? countDescendantsByStatus(selectedNode) : null;

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Status filters with legend tooltips */}
      <div className="flex items-center gap-1.5">
        <Filter className="h-3.5 w-3.5 text-muted-foreground" />
        {STATUS_OPTIONS.map((opt) => {
          const active = activeFilters.includes(opt.value);
          return (
            <div key={opt.value} className="relative">
              <button
                onClick={() => toggleFilter(opt.value)}
                onMouseEnter={() => setLegendHovered(opt.value)}
                onMouseLeave={() => setLegendHovered(null)}
                className={cn(
                  "flex items-center gap-1 rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-wider transition-all",
                  active
                    ? "border-transparent text-background"
                    : "border-border/60 text-muted-foreground hover:border-border hover:text-foreground",
                )}
                style={active ? { background: opt.color } : undefined}
              >
                {opt.label}
                <Info className="h-2.5 w-2.5 opacity-50" />
              </button>

              {/* Legend tooltip */}
              <AnimatePresence>
                {legendHovered === opt.value && (
                  <motion.div
                    initial={{ opacity: 0, y: 4, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 4, scale: 0.95 }}
                    transition={{ duration: 0.15 }}
                    className="absolute left-1/2 top-full z-50 mt-2 w-56 -translate-x-1/2 border bg-popover p-3 shadow-xl"
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ background: opt.color }}
                      />
                      <span className="font-mono text-[11px] font-semibold uppercase tracking-wider">
                        {opt.label}
                      </span>
                    </div>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      {opt.description}
                    </p>
                    {descendantCounts && selectedNode && (
                      <p className="mt-1.5 border-t border-border/40 pt-1.5 font-mono text-[10px] text-muted-foreground/70">
                        {descendantCounts[opt.value] ?? 0} in {selectedNode.name}'s subtree
                      </p>
                    )}
                    <div className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 border-l border-t bg-popover" />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
        {activeFilters.length > 0 && !hasUncommittedChanges && (
          <button
            onClick={() => onFiltersChange([])}
            className="ml-1 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Descendant filter toggle */}
      {showDescendantToggle && (
        <div className="flex items-center gap-2 rounded-full border px-3 py-1">
          <GitFork className="h-3 w-3 text-muted-foreground" />
          <span className="font-mono text-[10px] text-muted-foreground">
            {selectedNode.name} subtree
          </span>
          <Switch
            checked={descendantFilterEnabled ?? false}
            onCheckedChange={(val) => onDescendantFilterToggle?.(val)}
            className="h-4 w-7 [&>span]:h-3 [&>span]:w-3"
          />
        </div>
      )}

      {/* Multi-select badge */}
      {(multiSelectCount ?? 0) > 0 && (
        <div className="flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1">
          <span className="font-mono text-[10px] font-medium text-primary">
            {multiSelectCount} comparing
          </span>
          <button
            onClick={onClearSelection}
            className="ml-0.5 rounded-full p-0.5 text-primary/70 hover:bg-primary/20 hover:text-primary transition-colors"
            title="Clear selection"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Clear & Apply buttons for staged filters */}
      <AnimatePresence>
        {hasUncommittedChanges && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="flex items-center gap-1.5"
          >
            <Button
              variant="ghost"
              size="sm"
              onClick={onClearFilters}
              className="h-7 font-mono text-[10px] text-muted-foreground"
            >
              <RotateCcw className="mr-1 h-3 w-3" />
              Clear
            </Button>
            <Button size="sm" onClick={onApplyFilters} className="h-7 font-mono text-[10px]">
              <Check className="mr-1 h-3 w-3" />
              Apply
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Search */}
      <div ref={searchRef} className="relative">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Find clone…"
            value={searchQuery}
            onChange={(e) => {
              onSearchChange(e.target.value);
              setSearchOpen(e.target.value.length > 0);
            }}
            onFocus={() => searchQuery.length > 0 && setSearchOpen(true)}
            className="h-8 w-48 pl-8 font-mono text-xs"
          />
        </div>
        <AnimatePresence>
          {searchOpen && searchResults.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className="absolute left-0 top-full z-50 mt-1 max-h-48 w-64 overflow-y-auto border border-border bg-popover p-1 shadow-lg"
            >
              {searchResults.map((r) => (
                <button
                  key={r.id}
                  onClick={() => {
                    onSearchSelect(r.id);
                    setSearchOpen(false);
                  }}
                  className="flex w-full flex-col px-2 py-1.5 text-left hover:bg-accent"
                >
                  <span className="font-mono text-xs font-medium">{r.name}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">{r.repo}</span>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="flex-1" />

      {/* Which drawing. Disabled rather than hidden when WebGL cannot start:
          a control that vanishes reads as a feature this build does not have,
          and the reason is what an operator needs. */}
      {onViewChange && (
        <div className="flex items-center border" role="group" aria-label="Tree view">
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={view === "canopy"}
            disabled={!!canopyUnavailable}
            title={canopyUnavailable ?? "The fleet as a tree"}
            onClick={() => onViewChange("canopy")}
            className={cn(
              "h-7 rounded-none px-2 font-mono text-[10px]",
              view === "canopy" && "bg-primary/15 text-primary",
            )}
          >
            <Trees className="mr-1 h-3.5 w-3.5" />
            Canopy
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={view === "diagram"}
            title="The lineage as a diagram"
            onClick={() => onViewChange("diagram")}
            className={cn(
              "h-7 rounded-none px-2 font-mono text-[10px]",
              view === "diagram" && "bg-primary/15 text-primary",
            )}
          >
            <Network className="mr-1 h-3.5 w-3.5" />
            Diagram
          </Button>
        </div>
      )}

      {/* Zoom controls — the canopy has its own camera, so these are the
          diagram's and are hidden rather than left inert beside it. */}
      {view === "diagram" && (
        <div className="flex items-center gap-1 border px-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onZoomOut}
            title="Zoom out"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </Button>
          <span className="w-10 text-center font-mono text-[10px] text-muted-foreground">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onZoomIn}
            title="Zoom in"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onZoomReset}
            title="Reset"
          >
            <Maximize className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {/* Refresh */}
      <Button
        variant="outline"
        size="sm"
        onClick={onRefresh}
        disabled={refreshing}
        className="font-mono text-xs"
      >
        <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", refreshing && "animate-spin")} />
        {refreshing ? "Syncing…" : "Refresh statuses"}
      </Button>
    </div>
  );
}
