/**
 * The shape of a model-written brief: the engine's digest prompt asks for
 * `:::kind` fenced blocks (a verdict, headline metrics, tips, warnings,
 * insights) with plain markdown between them. This splits a brief into those
 * blocks and nothing more, so the page can draw each one as text — never as
 * markup the model chose.
 */
export type BriefBlock =
  | { kind: "fence"; fence: string; lines: string[] }
  | { kind: "para"; lines: string[] }
  | { kind: "list"; items: string[] }
  | { kind: "heading"; text: string };

export function parseBrief(text: string): BriefBlock[] {
  const blocks: BriefBlock[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const open = /^:::([a-z]+)\s*$/.exec(line.trim());
    if (open) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && lines[i].trim() !== ":::") {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ kind: "fence", fence: open[1], lines: body });
      i += 1;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i += 1;
      }
      blocks.push({ kind: "list", items });
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      blocks.push({ kind: "heading", text: line.replace(/^#{1,6}\s+/, "") });
      i += 1;
      continue;
    }
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^:::/.test(lines[i].trim()) &&
      !/^\s*[-*]\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push({ kind: "para", lines: para });
  }
  return blocks;
}
