/**
 * TreeStats — summary statistics displayed alongside the tree,
 * styled as Norse-themed stat cards.
 */

import { motion } from "framer-motion";
import { GitBranch, Zap, AlertTriangle, Shield, TreePine } from "lucide-react";
import type { Clone } from "@/lib/queries";
import { lineageDepth } from "./use-tree-layout";

interface Props {
  clones: Clone[];
}

export function TreeStats({ clones }: Props) {
  const total = clones.length;
  const synced = clones.filter((c) => c.sync_status === "in_sync").length;
  const behind = clones.filter((c) => c.sync_status === "behind").length;
  const failed = clones.filter((c) => c.sync_status === "failed").length;

  // Read from the recorded tree, never inferred. This line used to count
  // distinct first-tags — the same `tags[0]` guess `buildHierarchy` replaced,
  // left behind in the one place that puts a NUMBER on lineage. `tags` is a
  // cascade TARGETING field, so the figure moved whenever somebody re-targeted
  // a cascade, and on the fleet as recorded it read 0 for a tree two deep.
  const depth = lineageDepth(clones);

  const stats = [
    {
      label: "Roots",
      value: total,
      sublabel: "total clones",
      icon: TreePine,
      color: "oklch(0.78 0.16 200)",
    },
    {
      label: "Nourished",
      value: synced,
      sublabel: "in sync",
      icon: Zap,
      color: "oklch(0.78 0.18 150)",
    },
    {
      label: "Withering",
      value: behind,
      sublabel: "behind prime",
      icon: AlertTriangle,
      color: "oklch(0.82 0.17 80)",
    },
    {
      label: "Decaying",
      value: failed,
      sublabel: "sync failed",
      icon: Shield,
      color: "oklch(0.66 0.24 25)",
    },
    {
      label: "Branches",
      value: depth,
      sublabel: "lineage depth",
      icon: GitBranch,
      color: "oklch(0.72 0.14 290)",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {stats.map((s, i) => (
        <motion.div
          key={s.label}
          className="relative overflow-hidden border border-border/40 /80 p-4"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 + i * 0.08, duration: 0.5 }}
        >
          {/* Glow accent */}
          <div
            className="pointer-events-none absolute -right-4 -top-4 h-16 w-16 rounded-full opacity-15 blur-xl"
            style={{ background: s.color }}
          />
          <div className="flex items-center gap-2">
            <s.icon className="h-4 w-4" style={{ color: s.color }} />
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {s.label}
            </span>
          </div>
          <div className="mt-2 text-2xl font-bold tabular-nums" style={{ color: s.color }}>
            {s.value}
          </div>
          <div className="font-mono text-[10px] text-muted-foreground/60">{s.sublabel}</div>
        </motion.div>
      ))}
    </div>
  );
}
