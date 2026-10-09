// A model-written brief, drawn without ever handing the model's text to the
// DOM as markup.
//
// The digest prompt (the engine's `digestPrompt`) asks for `:::kind` fenced
// blocks — a verdict, headline metrics, tips, warnings, insights — with plain
// markdown between them. This renders exactly that much: fences, paragraphs,
// bullet lists, and **bold**. Everything is a React text node, so nothing a
// model writes can become an element it chose.
import type { ReactNode } from "react";
import { RecordRow, type SpineTone } from "@/components/record-row";
import { parseBrief, type BriefBlock } from "@/lib/marketing/briefParse.pure";

const FENCES: Record<string, { spine: SpineTone; label: string }> = {
  success: { spine: "ok", label: "verdict" },
  warning: { spine: "warn", label: "risk" },
  tip: { spine: "live", label: "action" },
  insight: { spine: "idle", label: "insight" },
  note: { spine: "idle", label: "note" },
  metric: { spine: "live", label: "metric" },
};

/** `**bold**` as <strong>; everything else as text. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  parts.forEach((part, i) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) out.push(<strong key={i}>{part.slice(2, -2)}</strong>);
    else if (part) out.push(part);
  });
  return out;
}

function Metric({ lines }: { lines: string[] }) {
  const field = (name: string) =>
    lines
      .find((l) => l.toLowerCase().startsWith(`${name}:`))
      ?.slice(name.length + 1)
      .trim() ?? null;
  const label = field("label");
  const value = field("value");
  const change = field("change");
  return (
    <RecordRow spine="live" className="px-4 py-3">
      <div className="numeral text-xl leading-none">{value ?? "—"}</div>
      <div className="label-mono mt-2">{label ?? "metric"}</div>
      {change && <div className="mt-1 font-mono text-[10px] text-muted-foreground">{change}</div>}
    </RecordRow>
  );
}

export function BriefText({ text }: { text: string }) {
  const blocks = parseBrief(text);
  const metrics = blocks.filter(
    (b): b is Extract<BriefBlock, { kind: "fence" }> => b.kind === "fence" && b.fence === "metric",
  );
  return (
    <div className="space-y-3 text-sm leading-relaxed [overflow-wrap:anywhere]">
      {metrics.length > 0 && (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {metrics.map((m, i) => (
            <Metric key={i} lines={m.lines} />
          ))}
        </div>
      )}
      {blocks.map((b, i) => {
        if (b.kind === "fence") {
          if (b.fence === "metric") return null;
          const f = FENCES[b.fence] ?? { spine: "idle" as SpineTone, label: b.fence };
          return (
            <RecordRow key={i} spine={f.spine} className="px-4 py-3">
              <p className="label-mono mb-1">{f.label}</p>
              {b.lines
                .filter((l) => l.trim())
                .map((l, j) => (
                  <p key={j}>{inline(l)}</p>
                ))}
            </RecordRow>
          );
        }
        if (b.kind === "list") {
          return (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {b.items.map((item, j) => (
                <li key={j}>{inline(item)}</li>
              ))}
            </ul>
          );
        }
        if (b.kind === "heading")
          return (
            <p key={i} className="label-mono pt-2">
              {b.text}
            </p>
          );
        return <p key={i}>{inline(b.lines.join(" "))}</p>;
      })}
    </div>
  );
}
