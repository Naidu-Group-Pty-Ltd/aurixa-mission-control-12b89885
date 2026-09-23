#!/usr/bin/env node
// Builds the Aurixa Systems voice-agent knowledge base.
//
//   node --experimental-strip-types scripts/voice/build-knowledge-doc.mjs
//   node --experimental-strip-types scripts/voice/build-knowledge-doc.mjs --check
//   node --experimental-strip-types scripts/voice/build-knowledge-doc.mjs --docx
//
// The type-stripping flag is needed because the pricing half imports the
// TypeScript price list directly; see knowledge-base/pricing-prose.mjs for why
// it is read rather than retyped.
//
// ── Markdown is the artefact, and that is a change ───────────────────────────
//
// This used to emit only a .docx, which was uploaded to VAPI by hand and then
// existed nowhere else: nothing was committed, no file id was recorded, and
// the document the live assistants actually queried could not be compared with
// anything. So the corpus is now rendered to Markdown and CHECKED IN beside
// this script, `--check` fails when the committed file is not what the content
// module produces, and the VAPI file id it was uploaded as is recorded in
// knowledge-base/vapi-file.json. The comparison is the bytes, because a
// generated artefact nothing compares is one that drifts.
//
// Word output is kept behind `--docx` for anyone who wants it, and needs the
// `docx` package, which this repository does not depend on.
import { writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INTRO, SECTIONS, TITLE } from "./knowledge-base/content.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MD_PATH = join(HERE, "knowledge-base", "aurixa-voice-knowledge-base.md");

function renderMarkdown() {
  const out = [`# ${TITLE}`, "", INTRO, ""];
  let inBullets = false;
  for (const block of SECTIONS) {
    if (block.kind === "b") {
      out.push(`- ${block.text}`);
      inBullets = true;
      continue;
    }
    if (inBullets) {
      out.push("");
      inBullets = false;
    }
    if (block.kind === "h1") out.push(`## ${block.text}`, "");
    else if (block.kind === "h2") out.push(`### ${block.text}`, "");
    else out.push(block.text, "");
  }
  // One trailing newline, never two: the file is compared byte for byte.
  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

async function renderDocx() {
  let docx;
  try {
    docx = await import("docx");
  } catch {
    console.error(
      "--docx needs the `docx` package, which this repository does not depend on.\n" +
        "Install it in a scratch directory and run this script from there, or use the\n" +
        "Markdown output, which is what is committed and uploaded.",
    );
    process.exit(2);
  }
  const { AlignmentType, Document, HeadingLevel, LevelFormat, Packer, Paragraph, TextRun } = docx;
  const para = (text) => new Paragraph({ children: [new TextRun(text)] });
  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(TITLE)] }),
    para(INTRO),
  ];
  for (const block of SECTIONS) {
    if (block.kind === "h1") children.push(new Paragraph({ text: block.text, heading: HeadingLevel.HEADING_1 }));
    else if (block.kind === "h2") children.push(new Paragraph({ text: block.text, heading: HeadingLevel.HEADING_2 }));
    else if (block.kind === "b")
      children.push(
        new Paragraph({
          numbering: { reference: "kb-bullets", level: 0 },
          children: [new TextRun(block.text)],
        }),
      );
    else children.push(para(block.text));
  }
  const doc = new Document({
    numbering: {
      config: [
        {
          reference: "kb-bullets",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "•",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 360, hanging: 200 } } },
            },
          ],
        },
      ],
    },
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

const md = renderMarkdown();

if (process.argv.includes("--check")) {
  let onDisk;
  try {
    onDisk = readFileSync(MD_PATH, "utf8");
  } catch {
    console.error(`missing: ${MD_PATH}\nRun this script to write it.`);
    process.exit(1);
  }
  if (onDisk !== md) {
    console.error(
      `the committed knowledge base has drifted from its content module:\n` +
        `  on disk        ${onDisk.length} characters\n` +
        `  content module ${md.length} characters\n\n` +
        `That file is generated. Edit knowledge-base/content.mjs and re-run this script.\n` +
        `Remember the uploaded copy: re-upload to VAPI and record the new file id in\n` +
        `knowledge-base/vapi-file.json, or the live agents keep answering from the old one.`,
    );
    process.exit(1);
  }
  const h1 = SECTIONS.filter((s) => s.kind === "h1").length;
  const h2 = SECTIONS.filter((s) => s.kind === "h2").length;
  console.log(`knowledge base matches its content module (${md.length} characters, ${h1} sections, ${h2} questions)`);
  process.exit(0);
}

if (process.argv.includes("--docx")) {
  const buffer = await renderDocx();
  const out = join(HERE, "knowledge-base", "aurixa-voice-knowledge-base.docx");
  writeFileSync(out, buffer);
  console.log(`wrote ${out} (${buffer.length} bytes)`);
}

writeFileSync(MD_PATH, md);
const h1 = SECTIONS.filter((s) => s.kind === "h1").length;
const h2 = SECTIONS.filter((s) => s.kind === "h2").length;
console.log(`wrote ${MD_PATH} (${md.length} characters, ${h1} sections, ${h2} question headings)`);
