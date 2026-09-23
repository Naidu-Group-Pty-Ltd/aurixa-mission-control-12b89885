// What changed between two build packages - the review an operator does
// before approving a new version.
//
// A line diff (longest common subsequence) per agent prompt and for the
// knowledge base, and a key-level comparison for tools and assistants. Prompts
// are a few hundred to ~1,500 lines, so the O(n*m) table is small; anything far
// larger is reported as "changed" rather than diffed, never silently skipped.
import type { BuildPackage } from "./package.pure.ts";

export type DiffLine = { op: "same" | "add" | "del"; text: string };

const MAX_CELLS = 4_000_000;

export function diffLines(a: string, b: string): DiffLine[] | null {
  const x = a.split("\n");
  const y = b.split("\n");
  if (x.length * y.length > MAX_CELLS) return null;
  const n = x.length;
  const m = y.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ op: "same", text: x[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: "del", text: x[i++] });
    else out.push({ op: "add", text: y[j++] });
  }
  while (i < n) out.push({ op: "del", text: x[i++] });
  while (j < m) out.push({ op: "add", text: y[j++] });
  return out;
}

/** Keep only changed lines and `context` lines around them. */
export function hunks(lines: DiffLine[], context = 2): Array<DiffLine | { op: "skip"; count: number }> {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.op !== "same") for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: Array<DiffLine | { op: "skip"; count: number }> = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) out.push({ op: "skip", count: skipped });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped) out.push({ op: "skip", count: skipped });
  return out;
}

export interface PackageDiff {
  agents: Array<{
    key: string;
    status: "added" | "removed" | "changed" | "same";
    added: number;
    removed: number;
    lines: DiffLine[] | null;
  }>;
  kb: { status: "added" | "removed" | "changed" | "same"; added: number; removed: number; lines: DiffLine[] | null };
  tools: Array<{ key: string; status: "added" | "removed" | "changed" | "same" }>;
  squadChanged: boolean;
}

export function diffPackages(prev: BuildPackage | null, next: BuildPackage): PackageDiff {
  const count = (lines: DiffLine[] | null) => ({
    added: lines?.filter((l) => l.op === "add").length ?? 0,
    removed: lines?.filter((l) => l.op === "del").length ?? 0,
  });
  const prevAgents = new Map((prev?.agents ?? []).map((a) => [a.key, a]));
  const nextAgents = new Map(next.agents.map((a) => [a.key, a]));
  const agentKeys = [...new Set([...prevAgents.keys(), ...nextAgents.keys()])].sort();
  const agents = agentKeys.map((key) => {
    const p = prevAgents.get(key);
    const n = nextAgents.get(key);
    if (!p) {
      const lines = diffLines("", n!.systemPrompt);
      return { key, status: "added" as const, ...count(lines), lines };
    }
    if (!n) return { key, status: "removed" as const, added: 0, removed: p.systemPrompt.split("\n").length, lines: null };
    const promptSame = p.systemPromptSha256 === n.systemPromptSha256;
    const bodySame = JSON.stringify(p.assistant) === JSON.stringify(n.assistant);
    if (promptSame && bodySame) return { key, status: "same" as const, added: 0, removed: 0, lines: null };
    const lines = promptSame ? [] : diffLines(p.systemPrompt, n.systemPrompt);
    return { key, status: "changed" as const, ...count(lines), lines };
  });

  let kb: PackageDiff["kb"];
  if (!prev?.kb && !next.kb) kb = { status: "same", added: 0, removed: 0, lines: null };
  else if (!prev?.kb) {
    const lines = diffLines("", next.kb!.text);
    kb = { status: "added", ...count(lines), lines };
  } else if (!next.kb) kb = { status: "removed", added: 0, removed: prev.kb.text.split("\n").length, lines: null };
  else if (prev.kb.sha256 === next.kb.sha256) kb = { status: "same", added: 0, removed: 0, lines: null };
  else {
    const lines = diffLines(prev.kb.text, next.kb.text);
    kb = { status: "changed", ...count(lines), lines };
  }

  const pt = new Map((prev?.tools ?? []).map((t) => [t.key, JSON.stringify(t)]));
  const nt = new Map(next.tools.map((t) => [t.key, JSON.stringify(t)]));
  const tools = [...new Set([...pt.keys(), ...nt.keys()])].sort().map((key) => ({
    key,
    status: !pt.has(key) ? ("added" as const) : !nt.has(key) ? ("removed" as const) : pt.get(key) === nt.get(key) ? ("same" as const) : ("changed" as const),
  }));

  return {
    agents,
    kb,
    tools,
    squadChanged: JSON.stringify(prev?.squad ?? null) !== JSON.stringify(next.squad),
  };
}
