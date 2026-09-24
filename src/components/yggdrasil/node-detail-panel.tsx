/**
 * YggdrasilNodePanel — a slide-in panel showing details about a
 * selected clone node on the tree, with visual lineage breadcrumb.
 */

import { useMemo } from "react";
import { motion } from "framer-motion";
import { Link } from "@tanstack/react-router";
import { X, GitBranch, ExternalLink, Github, TreePine, Ban, CircleDashed } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusPill } from "@/components/status-pill";
import type { TreeNode } from "./use-tree-layout";
import { membranesTouching } from "@/lib/cascade/membrane/fleetMembranes.pure";
import {
  lateralsTouching,
  otherSide,
  type LateralBoundary,
} from "@/lib/cascade/membrane/lateralMembranes.pure";
import type { Membrane } from "@/lib/cascade/membrane/membrane.pure";

interface Props {
  node: TreeNode;
  allNodes: TreeNode[];
  onClose: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  in_sync: "oklch(0.78 0.18 150)",
  behind: "oklch(0.82 0.17 80)",
  failed: "oklch(0.66 0.24 25)",
  unknown: "oklch(0.60 0.10 250)",
  cascading: "oklch(0.70 0.18 220)",
};

/** Walk from node up to trunk, building a breadcrumb path */
function buildLineage(node: TreeNode, allNodes: TreeNode[]): TreeNode[] {
  const nodeMap = new Map(allNodes.map((n) => [n.id, n]));
  const path: TreeNode[] = [node];
  let current = node;
  while (current.parentId) {
    const parent = nodeMap.get(current.parentId);
    if (!parent) break;
    path.unshift(parent);
    current = parent;
  }
  return path;
}

/** Generate a hue-based branch color from the node's hue */
function branchColor(hue: number): string {
  return `oklch(0.72 0.16 ${hue})`;
}

/**
 * One boundary, in one line.
 *
 * It names what is REFUSED and what waits on a person, because that is the
 * difference between one edge and another — every membrane in this fleet
 * carries the same nine standing organs, so counting them would print the
 * same number under every node.
 */
function MembraneLine({ label, membrane }: { label: "in" | "out"; membrane: Membrane }) {
  const closed = membrane.channels.filter((c) => c.state === "closed");
  const gated = membrane.channels.filter((c) => c.state === "gated");
  const other = label === "in" ? membrane.from : membrane.to;
  return (
    <div className="flex items-start gap-1.5 font-mono text-[11px]">
      <span className="w-6 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate text-foreground" title={other}>
        {other}
      </span>
      {closed.length > 0 ? (
        <span
          className="flex shrink-0 items-center gap-0.5 text-destructive"
          title={closed.map((c) => c.note).join(" ")}
        >
          <Ban className="h-3 w-3" />
          {closed.length}
        </span>
      ) : null}
      {gated.length > 0 ? (
        <span
          className="flex shrink-0 items-center gap-0.5 text-warning"
          title={gated.map((c) => c.note).join(" ")}
        >
          <CircleDashed className="h-3 w-3" />
          {gated.length}
        </span>
      ) : null}
    </div>
  );
}

/**
 * A boundary BESIDE this deployment, rather than above or below it.
 *
 * Both directions are counted, separately, because a lateral boundary's two
 * membranes are not mirror images — the CRM line runs opposite ways across
 * them — so one count for the pair would describe neither.
 */
function LateralLine({ repo, boundary }: { repo: string; boundary: LateralBoundary }) {
  const other = otherSide(boundary, repo);
  if (!other) return null;
  const directions: Array<{ word: "in" | "out"; membrane: Membrane | undefined }> = [
    { word: "in", membrane: boundary.toward[repo] },
    { word: "out", membrane: boundary.toward[other] },
  ];
  return (
    <div className="flex flex-col gap-0.5 font-mono text-[11px]">
      <div className="flex items-start gap-1.5">
        <span className="w-6 shrink-0 text-muted-foreground" title="Beside: work crosses both ways">
          <span aria-hidden>⇄</span>
          <span className="sr-only">beside</span>
        </span>
        <span className="min-w-0 flex-1 truncate text-foreground" title={other}>
          {other}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 pl-[1.875rem] text-[10px] text-muted-foreground">
        {directions.map(({ word, membrane }) => {
          if (!membrane) return <span key={word}>{word} — nothing crosses</span>;
          const closed = membrane.channels.filter((c) => c.state === "closed");
          const gated = membrane.channels.filter((c) => c.state === "gated");
          return (
            <span key={word} className="flex items-center gap-1">
              {word}
              {closed.length > 0 ? (
                <span
                  className="flex items-center gap-0.5 text-destructive"
                  title={closed.map((c) => c.note).join(" ")}
                >
                  <Ban className="h-3 w-3" />
                  {closed.length}
                </span>
              ) : null}
              {gated.length > 0 ? (
                <span
                  className="flex items-center gap-0.5 text-warning"
                  title={gated.map((c) => c.note).join(" ")}
                >
                  <CircleDashed className="h-3 w-3" />
                  {gated.length}
                </span>
              ) : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function YggdrasilNodePanel({ node, allNodes, onClose }: Props) {
  const lineage = useMemo(() => buildLineage(node, allNodes), [node, allNodes]);
  const membranes = useMemo(() => membranesTouching(node.githubRepo), [node.githubRepo]);
  const laterals = useMemo(() => lateralsTouching(node.githubRepo), [node.githubRepo]);

  return (
    <motion.div
      className="absolute bottom-4 right-4 z-40 w-80 border /95 p-5 shadow-2xl backdrop-blur-xl"
      initial={{ opacity: 0, x: 40, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 40, scale: 0.95 }}
      transition={{ type: "spring", stiffness: 300, damping: 25 }}
    >
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-base font-semibold">{node.name}</h3>
          <p className="mt-0.5 font-mono text-xs text-muted-foreground">
            {node.githubOwner}/{node.githubRepo}
          </p>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Visual lineage breadcrumb — tree branch path */}
      <div className="mt-3 bg-muted/30 border border-border/30 p-3 overflow-x-auto">
        <div className="flex flex-col gap-0">
          {lineage.map((n, i) => {
            const isCurrent = n.id === node.id;
            const isTrunk = n.id === "__trunk__";
            const statusColor = STATUS_COLORS[n.syncStatus] ?? STATUS_COLORS.unknown;
            const bColor = branchColor(n.hue);
            const isLast = i === lineage.length - 1;

            return (
              <div key={n.id} className="flex items-stretch gap-0">
                {/* Vertical branch connector */}
                <div className="flex flex-col items-center w-5 shrink-0">
                  {/* Node dot */}
                  <div
                    className="relative z-10 shrink-0 rounded-full border-2"
                    style={{
                      width: isTrunk ? 14 : isCurrent ? 12 : 8,
                      height: isTrunk ? 14 : isCurrent ? 12 : 8,
                      background: isTrunk ? "oklch(0.78 0.16 200)" : statusColor,
                      borderColor: isTrunk ? "oklch(0.85 0.18 195)" : bColor,
                      boxShadow: isCurrent ? `0 0 8px ${statusColor}` : "none",
                    }}
                  />
                  {/* Vertical line to next node */}
                  {!isLast && (
                    <div
                      className="w-0.5 flex-1 min-h-3"
                      style={{
                        background: `linear-gradient(to bottom, ${bColor}, ${branchColor(lineage[i + 1].hue)})`,
                        opacity: 0.6,
                      }}
                    />
                  )}
                </div>

                {/* Label and repo info */}
                <div className={`pl-2 ${isLast ? "pb-0" : "pb-2"}`}>
                  {isTrunk ? (
                    <div className="flex items-center gap-1">
                      <TreePine className="h-3 w-3 text-primary" />
                      <span className="font-mono text-[10px] font-bold text-primary tracking-wider">
                        PRIME TRUNK
                      </span>
                    </div>
                  ) : (
                    <>
                      <span
                        className={`font-mono text-[10px] leading-tight ${
                          isCurrent
                            ? "font-bold text-foreground"
                            : "font-medium text-muted-foreground"
                        }`}
                      >
                        {n.name}
                      </span>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="font-mono text-[8px] text-muted-foreground/60">
                          {n.githubOwner}/{n.githubRepo}
                        </span>
                        {/* Branch indicator — which direction in the tree */}
                        <span
                          className="inline-block h-1 w-4 rounded-full"
                          style={{
                            background: bColor,
                            opacity: 0.5,
                          }}
                        />
                        <span
                          className="font-mono text-[7px] uppercase tracking-wider"
                          style={{ color: statusColor, opacity: 0.8 }}
                        >
                          {n.syncStatus.replace("_", " ")}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <div className="flex items-center gap-2">
          <StatusPill
            status={node.syncStatus as "in_sync" | "behind" | "failed" | "unknown" | "cascading"}
            behind={node.commitsBehind}
          />
          {node.commitsBehind > 0 && (
            <span className="font-mono text-xs text-warning">
              {node.commitsBehind} commit{node.commitsBehind === 1 ? "" : "s"} behind
            </span>
          )}
        </div>

        {node.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {node.tags.map((t) => (
              <Badge key={t} variant="outline" className="font-mono text-[10px]">
                #{t}
              </Badge>
            ))}
          </div>
        )}

        <div className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
          <GitBranch className="h-3 w-3" />
          Depth {node.depth} in tree hierarchy
        </div>

        {/* The boundaries either side of this deployment.
            Read-only: the band on the diagram is the control, and two ways to
            open one panel is how the two come to disagree about which is
            selected. What this adds is the thing a node alone cannot say —
            that what reaches it was filtered on the way in, and that what
            leaves it is filtered again. */}
        {membranes.inbound || membranes.outbound.length > 0 || laterals.length > 0 ? (
          <div className="border-t border-border/30 pt-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Membranes
            </p>
            <div className="mt-1.5 flex flex-col gap-1">
              {membranes.inbound ? (
                <MembraneLine label="in" membrane={membranes.inbound} />
              ) : (
                <p className="font-mono text-[11px] text-muted-foreground">
                  in — none; this is the fleet's source
                </p>
              )}
              {membranes.outbound.map((m) => (
                <MembraneLine key={m.to} label="out" membrane={m} />
              ))}
              {laterals.map((boundary) => (
                <LateralLine key={boundary.id} repo={node.githubRepo} boundary={boundary} />
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex gap-2 pt-2">
          <Link to="/clones/$cloneId" params={{ cloneId: node.id }}>
            <Button size="sm" variant="outline" className="font-mono text-xs">
              <ExternalLink className="mr-1.5 h-3 w-3" /> View clone
            </Button>
          </Link>
          <a
            href={`https://github.com/${node.githubOwner}/${node.githubRepo}`}
            target="_blank"
            rel="noreferrer"
          >
            <Button size="sm" variant="ghost" className="font-mono text-xs">
              <Github className="mr-1.5 h-3 w-3" /> Repo
            </Button>
          </a>
        </div>
      </div>
    </motion.div>
  );
}
