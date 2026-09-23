#!/usr/bin/env node
// Check that every NPC heading the recipe book's playbooks were distilled from
// still exists in the NPC repository.
//
//   node --experimental-strip-types scripts/voice/check-recipe-provenance.mjs --npc ../npc-property-dashbord
//
// The playbooks in src/lib/voice-recipe/sections/playbooks.pure.ts are a port,
// not a copy: the rule is kept and NPC's specifics dropped. When NPC's live
// prompt for a section changes, the port should be reviewed against it - this
// finds the sections to look at. It is not in CI because CI does not check out
// the NPC repository; run it when NPC's prompts are refreshed.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PLAYBOOK_PROVENANCE } from "../../src/lib/voice-recipe/sections/playbooks.pure.ts";

const i = process.argv.indexOf("--npc");
const root = i > -1 ? process.argv[i + 1] : "../npc-property-dashbord";
if (!existsSync(root)) {
  console.error(`NPC repository not found at ${root}. Pass --npc <path>.`);
  process.exit(2);
}

const strip = (s) => s.replace(/\*/g, "").replace(/^#+\s*/, "").trim();
let missing = 0;
let checked = 0;
for (const [id, sources] of Object.entries(PLAYBOOK_PROVENANCE)) {
  for (const s of sources) {
    checked++;
    const path = join(root, s.file);
    if (!existsSync(path)) {
      console.log(`MISSING FILE  ${id}: ${s.file}`);
      missing++;
      continue;
    }
    const headings = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("#"))
      .map(strip);
    if (!headings.includes(s.heading)) {
      console.log(`MISSING HEADING  ${id}: "${s.heading}" in ${s.file}`);
      missing++;
    }
  }
}
console.log(`${checked - missing} of ${checked} playbook sources found`);
process.exit(missing ? 1 : 0);
