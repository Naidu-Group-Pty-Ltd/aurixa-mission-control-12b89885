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
import { createHash } from "node:crypto";
import { writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INTRO, SECTIONS, TITLE } from "./knowledge-base/content.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MD_PATH = join(HERE, "knowledge-base", "aurixa-voice-knowledge-base.md");
const VAPI_FILE_PATH = join(HERE, "knowledge-base", "vapi-file.json");

// The corpus is rendered ASCII-only.
//
// Typographic quotes and dashes buy nothing here: the document is matched by a
// retrieval index and spoken by a TTS engine, neither of which reads a U+2014
// differently from a hyphen. What they cost is real - the file is carried by
// hand between this repository and a vendor's file store, and every step of
// that journey is somewhere an encoding can be mangled silently. An ASCII
// artefact can be compared byte for byte at either end.
const ASCII = [
  [/[\u2018\u2019\u201a\u201b]/g, "'"],
  [/[\u201c\u201d\u201e\u201f]/g, '"'],
  [/[\u2013\u2014\u2015]/g, "-"],
  [/\u2026/g, "..."],
  [/\u00a0/g, " "],
];

function toAscii(text) {
  let out = text;
  for (const [re, to] of ASCII) out = out.replace(re, to);
  const stray = out.match(/[^\x09\x0a\x20-\x7e]/g);
  if (stray) {
    // Named rather than stripped: a character nobody decided about is a
    // content question, not something a renderer should quietly resolve.
    console.error(
      `non-ASCII characters remain in the corpus: ${[...new Set(stray)].join(" ")}\n` +
        "Add a rule to ASCII in build-knowledge-doc.mjs, or write it in ASCII.",
    );
    process.exit(1);
  }
  return out;
}

// Claims this corpus must never make, checked on the RENDERED output.
//
// The first entry is a standing instruction from the business: one property-
// data provider is not to be mentioned at all, under its old name, its new
// name or its product name. It used to appear once, in the integrations
// answer, and a rule that lives only in a reviewer's memory is one a future
// edit reintroduces with nothing noticing. The others are claims found on the
// public website that nothing verifies - an unfiled patent, certifications
// held by infrastructure providers rather than by Aurixa, and outcome figures
// no customer has measured - and a voice agent repeating any of them to a
// prospect is making the claim itself.
//
// The check reads the rendered Markdown rather than the content module, so it
// sees exactly what is uploaded, including everything generated from the
// catalog. A match refuses to write, and refuses --check, naming the rule.
const DENYLIST = [
  [/core\s*logic/i, "a property-data provider the business has said is never to be mentioned"],
  [/cotality/i, "the same provider under its current name"],
  [/\brp\s*data\b/i, "the same provider's property product"],
  [/proptrack|pricefinder/i, "a named property-data provider - no data provider is named"],
  [/\bpatent(ed|[- ]pending)\b/i, "a patent claim - no application has been filed"],
  [/\bsoc\s*2\b|\biso(\/iec)?\s*27001\b/i, "a certification claim - held by infrastructure providers, not by Aurixa"],
  [/\b10x\b|\bten times\b|conversion lift/i, "an outcome figure no customer has measured"],
];

function assertNoDeniedClaims(text) {
  const hits = [];
  text.split("\n").forEach((line, i) => {
    for (const [re, why] of DENYLIST) {
      const m = line.match(re);
      if (m) hits.push(`  line ${i + 1}: "${m[0]}" - ${why}`);
    }
  });
  if (hits.length) {
    console.error(
      `the knowledge base makes a claim it must not make:\n${hits.join("\n")}\n\n` +
        "Remove it from knowledge-base/content.mjs, or from the catalog it was generated from.",
    );
    process.exit(1);
  }
}

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
  return toAscii(`${out.join("\n").replace(/\n+$/, "")}\n`);
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
assertNoDeniedClaims(md);

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
  // The committed file matching its content module says nothing about the
  // copy the live agents read. vapi-file.json records the SHA-256 of what was
  // uploaded; when it differs, the corpus was edited and never re-uploaded,
  // and every agent is still answering from the old one.
  const uploaded = JSON.parse(readFileSync(VAPI_FILE_PATH, "utf8"));
  const sha256 = createHash("sha256").update(md, "utf8").digest("hex");
  if (uploaded.file_id && uploaded.sha256 !== sha256) {
    console.error(
      `the committed knowledge base is not the one the live agents read:\n` +
        `  committed          sha256 ${sha256}\n` +
        `  uploaded to VAPI   sha256 ${uploaded.sha256} (file ${uploaded.file_id})\n\n` +
        `Upload the committed file to VAPI as text/plain (see vapi-file.json), check the\n` +
        `store reports status=done, record its file id, bytes and SHA-256 there, and\n` +
        `re-point the fleet with apply-fleet-upgrade.py.`,
    );
    process.exit(1);
  }
  const h1 = SECTIONS.filter((s) => s.kind === "h1").length;
  const h2 = SECTIONS.filter((s) => s.kind === "h2").length;
  console.log(
    `knowledge base matches its content module and the uploaded copy ` +
      `(${md.length} characters, ${h1} sections, ${h2} questions, VAPI file ${uploaded.file_id})`,
  );
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
