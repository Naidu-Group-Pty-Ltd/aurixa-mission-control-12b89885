import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BODY_CUT_NOTE,
  GITHUB_PR_BODY_LIMIT,
  PR_BODY_BUDGET_BYTES,
  fitPullRequestBody,
  omittedFilesLine,
} from "./pullRequestBodyBudget.pure";

const bytes = (s: string) => new TextEncoder().encode(s).length;
const files = (n: number, prefix = "src/components/some/fairly/long/directory/name") =>
  Array.from({ length: n }, (_, i) => `- \`${prefix}/file-${i}.tsx\``);

describe("fitPullRequestBody", () => {
  it("returns a body that fits exactly as it would have been written", () => {
    const head = "Lead\n\nScope: **modules**.\n\nFiles synchronized:\n\n";
    const items = files(20);
    const tail = "\n\n### Needs a human — 1 file(s)\n\n- `x`";
    const fitted = fitPullRequestBody({ head, items, tail });
    expect(fitted.body).toBe(head + items.join("\n") + tail);
    expect(fitted.omittedItems).toBe(0);
    expect(fitted.cutWhole).toBe(false);
  });

  it("shortens only the file list, keeping every other section whole", () => {
    // The shape of the failure on 13 Oct 2026: a clone far enough behind that
    // the list alone passes GitHub's limit.
    const head = "Cascade from prime@c4d88bd.\n\nScope: **mirror**.\n\nFiles synchronized:\n\n";
    const items = files(1200);
    const tail =
      "\n\n### ⚠ This cascade breaks a held file\n\n- `src/App.tsx` imports `X`\n\n" +
      "### Needs a human — 2 file(s) changed upstream and were held back\n\n- `a`\n- `b`";
    expect(bytes(head + items.join("\n") + tail)).toBeGreaterThan(GITHUB_PR_BODY_LIMIT);

    const fitted = fitPullRequestBody({ head, items, tail });
    expect(bytes(fitted.body)).toBeLessThanOrEqual(PR_BODY_BUDGET_BYTES);
    expect(fitted.body.startsWith(head)).toBe(true);
    expect(fitted.body.endsWith(tail)).toBe(true);
    expect(fitted.cutWhole).toBe(false);
    expect(fitted.omittedItems).toBeGreaterThan(0);
    expect(fitted.body).toContain(omittedFilesLine(fitted.omittedItems));
    // What is kept is a prefix of the list, in order, with nothing invented.
    const kept = items.length - fitted.omittedItems;
    expect(fitted.body).toContain(
      items.slice(0, kept).join("\n") + "\n" + omittedFilesLine(fitted.omittedItems),
    );
    expect(fitted.body).not.toContain(items[kept]);
  });

  it("uses the room it has rather than cutting further than it must", () => {
    const head = "H\n\n";
    const items = files(3000);
    const tail = "\n\nT";
    const fitted = fitPullRequestBody({ head, items, tail });
    const kept = items.length - fitted.omittedItems;
    // One more item would not have fitted.
    const oneMore =
      head +
      items.slice(0, kept + 1).join("\n") +
      "\n" +
      omittedFilesLine(fitted.omittedItems - 1) +
      tail;
    expect(bytes(oneMore)).toBeGreaterThan(PR_BODY_BUDGET_BYTES - 10);
  });

  it("counts bytes, so non-ASCII paths cannot carry a body over by character count", () => {
    const head = "Files:\n\n";
    const items = files(2000, "src/ünïcödé/目录/ディレクトリ");
    const fitted = fitPullRequestBody({ head, items, tail: "" });
    expect(bytes(fitted.body)).toBeLessThanOrEqual(PR_BODY_BUDGET_BYTES);
    expect(fitted.body.length).toBeLessThan(GITHUB_PR_BODY_LIMIT);
  });

  it("cuts the whole body at a line, and says so, only when the other sections alone are too long", () => {
    const head = "Lead\n\nFiles synchronized:\n\n";
    const items = files(50);
    const tail =
      "\n\n### Needs a human\n\n" +
      Array.from({ length: 4000 }, (_, i) => `- \`held/path/number-${i}.ts\``).join("\n");
    const fitted = fitPullRequestBody({ head, items, tail });
    expect(fitted.cutWhole).toBe(true);
    expect(fitted.omittedItems).toBe(items.length);
    expect(bytes(fitted.body)).toBeLessThanOrEqual(PR_BODY_BUDGET_BYTES);
    expect(fitted.body.endsWith(BODY_CUT_NOTE)).toBe(true);
    expect(fitted.body.startsWith(head + omittedFilesLine(items.length))).toBe(true);
    // Cut at a line: nothing before the note ends half way through a path.
    const beforeNote = fitted.body.slice(0, -BODY_CUT_NOTE.length).trimEnd();
    expect(beforeNote.endsWith(".ts`")).toBe(true);
  });

  it("honours a budget it is given", () => {
    const fitted = fitPullRequestBody({
      head: "h\n",
      items: files(100),
      tail: "\nt",
      budgetBytes: 2_000,
    });
    expect(bytes(fitted.body)).toBeLessThanOrEqual(2_000);
    expect(fitted.body.endsWith("\nt")).toBe(true);
  });

  it("keeps the budget below GitHub's limit", () => {
    expect(PR_BODY_BUDGET_BYTES).toBeLessThan(GITHUB_PR_BODY_LIMIT);
  });
});

describe("the cascade engine's pull request body", () => {
  const src = readFileSync(join(__dirname, "..", "cascade-engine.server.ts"), "utf8");

  it("is fitted on both the path that opens a pull request and the path that refreshes one", () => {
    const bodyStart = src.indexOf("const cascadeBody =");
    expect(bodyStart).toBeGreaterThan(-1);
    const definition = src.slice(bodyStart, src.indexOf("const { data: newCommit }", bodyStart));
    expect(definition).toContain("fitPullRequestBody(");
    // Both call sites go through the one fitted definition.
    expect(src.match(/body: cascadeBody\(/g)?.length).toBe(2);
  });
});
