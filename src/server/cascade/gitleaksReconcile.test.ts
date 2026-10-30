import { describe, expect, it } from "vitest";
import {
  appendOwnKeyAllowlist,
  describeGitleaksReconcile,
  gitleaksAllowsKey,
  reconcileGitleaksToml,
  supabaseKeysAllowed,
} from "./gitleaksReconcile.pure";

/**
 * Keys are BUILT rather than pasted, as in `clone-repo-retarget.server.test.ts`:
 * a real anon key in a fixture is a real credential in a repository, and the
 * thing under test is the decode.
 */
const jwt = (ref: string, role = "anon") => {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o))
      .toString("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "supabase", ref, role })}.sig-${ref}-${role}`;
};
const escaped = (key: string) => key.split(".").join("\\.");

const PRIME = "dduzbchuswwbefdunfct";
const PARENT = "qvuwrvwzjyigptmnijyb";
const CLONE = "fxqfhiiqdmzvsxbxvqcz";
const PRIME_KEY = jwt(PRIME);
const PARENT_KEY = jwt(PARENT);
const CLONE_KEY = jwt(CLONE);
const q = "'''";

const keyBlock = (description: string, key: string) =>
  [
    "[[allowlists]]",
    `description = "${description}"`,
    "regexes = [",
    `  ${q}${key}${q},`,
    "]",
  ].join("\n");

// Prime's shape: a header, `[extend]`, its own key, and allowances by value.
const PRIME_TOML = [
  "# Secret scanning for this repository.",
  "#",
  "# All of these are role=anon for THIS project.",
  "",
  "[extend]",
  "useDefault = true",
  "",
  keyBlock("This project's own Supabase anon key.", escaped(PRIME_KEY)),
  "",
  "[[allowlists]]",
  'description = "Generated build output."',
  `paths = [${q}^dist/.*${q}]`,
  "",
  "[[allowlists]]",
  'description = "Documented test values."',
  "regexes = [",
  `  ${q}^ci-token$${q},`,
  `  ${q}-----BEGIN [A-Z ]*PRIVATE KEY-----(/g|\\\\n|[\\x27"])${q},`,
  "]",
  "",
].join("\n");

// A lineage parent's file, as provisioning left it: prime's, plus its own key.
const PARENT_TOML = appendOwnKeyAllowlist(PRIME_TOML, PARENT, PARENT_KEY);

const prime = { kind: "prime" } as const;
const parent = { kind: "deployment", ownRef: PARENT } as const;

describe("reconcileGitleaksToml — a clone that reads the prime", () => {
  const cloneToml = [
    "# This clone's own header, rewritten by hand.",
    "[extend]",
    "useDefault = true",
    "",
    keyBlock("This deployment's own key.", escaped(CLONE_KEY)),
    "",
    keyBlock("The PRIME's key, in inherited migrations.", PRIME_KEY),
    "",
    "[[allowlists]]",
    'description = "Documented test values."',
    "regexes = [",
    `  ${q}^ci-token$${q},`,
    `  ${q}^old-planted-key$${q},`,
    `  ${q}-----BEGIN [A-Z ]*PRIVATE KEY-----(/g|\\\\n|['"])${q},`,
    "]",
    "",
  ].join("\n");
  const verdict = reconcileGitleaksToml({
    sourceToml: PRIME_TOML,
    cloneToml,
    ownRef: CLONE,
    registeredRef: CLONE,
    source: prime,
  });

  it("is prime's file, whole, with this deployment's own key put back", () => {
    if (!verdict.ok) throw new Error(verdict.reason);
    expect(verdict.merged.startsWith(PRIME_TOML.trimEnd())).toBe(true);
    expect(verdict.merged.slice(PRIME_TOML.trimEnd().length)).toMatch(
      /^\n\n\[\[allowlists\]\]\ndescription = "This deployment's own Supabase anon \(publishable\) key, for project fxqfhiiqdmzvsxbxvqcz\./,
    );
    expect(verdict.changed).toBe(true);
    expect(verdict.ownRef).toBe(CLONE);
  });

  it("allows the prime's key and this deployment's own, and no other", () => {
    if (!verdict.ok) throw new Error(verdict.reason);
    expect(supabaseKeysAllowed(verdict.merged).map((k) => k.ref)).toEqual([PRIME, CLONE]);
    // The own key is written as the bare token, one literal.
    expect(verdict.merged).toContain(`  ${q}${CLONE_KEY}${q},`);
  });

  it("names what the clone's copy let through and the result does not", () => {
    if (!verdict.ok) throw new Error(verdict.reason);
    expect(verdict.keysDropped).toEqual([]);
    // The PEM class is `['"]` on one side and `[\x27"]` on the other: one value.
    expect(verdict.allowancesDropped).toEqual([
      { description: "Documented test values.", values: 1 },
    ]);
  });

  it("changes nothing on the next pass", () => {
    if (!verdict.ok) throw new Error(verdict.reason);
    const again = reconcileGitleaksToml({
      sourceToml: PRIME_TOML,
      cloneToml: verdict.merged,
      ownRef: CLONE,
      registeredRef: CLONE,
      source: prime,
    });
    expect(again).toMatchObject({
      ok: true,
      changed: false,
      keysDropped: [],
      allowancesDropped: [],
    });
  });

  it("carries a change prime makes outside the key on the same pass", () => {
    // The 30 Oct incident: prime swapped one allowed literal for another.
    const swapped = PRIME_TOML.replace("^ci-token$", "^ci-token-v2$");
    if (!verdict.ok) throw new Error(verdict.reason);
    const next = reconcileGitleaksToml({
      sourceToml: swapped,
      cloneToml: verdict.merged,
      ownRef: CLONE,
      registeredRef: null,
      source: prime,
    });
    if (!next.ok) throw new Error(next.reason);
    expect(next.changed).toBe(true);
    expect(next.merged).toContain("^ci-token-v2$");
    expect(next.merged).not.toContain("^ci-token$");
    expect(next.allowancesDropped).toEqual([{ description: "Documented test values.", values: 1 }]);
  });
});

describe("reconcileGitleaksToml — a child that reads its parent", () => {
  it("takes the parent's own key out and keeps the prime's", () => {
    const cloneToml = appendOwnKeyAllowlist(PRIME_TOML, CLONE, CLONE_KEY);
    const v = reconcileGitleaksToml({
      sourceToml: PARENT_TOML,
      cloneToml,
      ownRef: CLONE,
      registeredRef: CLONE,
      source: parent,
    });
    if (!v.ok) throw new Error(v.reason);
    expect(supabaseKeysAllowed(v.merged).map((k) => k.ref)).toEqual([PRIME, CLONE]);
    expect(v.merged).not.toContain(PARENT);
    // Its result is what the same clone would derive from the prime directly.
    const direct = reconcileGitleaksToml({
      sourceToml: PRIME_TOML,
      cloneToml,
      ownRef: CLONE,
      registeredRef: null,
      source: prime,
    });
    if (!direct.ok) throw new Error(direct.reason);
    expect(v.merged).toBe(direct.merged);
  });

  it("says when the clone's copy allowed the parent's key — Tutorial Demo's stale entry", () => {
    const cloneToml = [
      PARENT_TOML.trimEnd(),
      "",
      keyBlock("This deployment's own key.", CLONE_KEY),
      "",
    ].join("\n");
    const v = reconcileGitleaksToml({
      sourceToml: PARENT_TOML,
      cloneToml,
      ownRef: CLONE,
      registeredRef: CLONE,
      source: parent,
    });
    if (!v.ok) throw new Error(v.reason);
    expect(v.keysDropped).toEqual([{ ref: PARENT, role: "anon" }]);
    expect(describeGitleaksReconcile(v, "npc-crm-independent-6505dc's")).toContain(
      "no longer allows the key for `qvuwrvwzjyigptmnijyb` (anon)",
    );
  });

  it("takes out a comment written against the parent's block, and nothing below it", () => {
    const sourceToml = [
      "[extend]",
      "useDefault = true",
      "",
      "# Converted from the singular form.",
      keyBlock("The parent's own key — see the header.", PARENT_KEY),
      "",
      "# A note about the next block.",
      keyBlock("The PRIME's key.", escaped(PRIME_KEY)),
      "",
    ].join("\n");
    const v = reconcileGitleaksToml({
      sourceToml,
      cloneToml: appendOwnKeyAllowlist(sourceToml, CLONE, CLONE_KEY),
      ownRef: CLONE,
      registeredRef: null,
      source: parent,
    });
    if (!v.ok) throw new Error(v.reason);
    expect(v.merged).not.toContain("Converted from the singular form.");
    expect(v.merged).toContain(
      "useDefault = true\n\n# A note about the next block.\n[[allowlists]]",
    );
  });

  it("takes out only the line where the parent's key shares its array", () => {
    const sourceToml = [
      "[[allowlists]]",
      'description = "Keys."',
      "regexes = [",
      `  ${q}${PARENT_KEY}${q},`,
      `  ${q}${escaped(PRIME_KEY)}${q},`,
      "]",
      "",
    ].join("\n");
    const v = reconcileGitleaksToml({
      sourceToml,
      cloneToml: appendOwnKeyAllowlist("", CLONE, CLONE_KEY),
      ownRef: CLONE,
      registeredRef: null,
      source: parent,
    });
    if (!v.ok) throw new Error(v.reason);
    expect(
      v.merged.startsWith(
        `[[allowlists]]\ndescription = "Keys."\nregexes = [\n  ${q}${escaped(PRIME_KEY)}${q},\n]`,
      ),
    ).toBe(true);
  });
});

describe("reconcileGitleaksToml — refusing is the default", () => {
  const cloneToml = appendOwnKeyAllowlist(PRIME_TOML, CLONE, CLONE_KEY);
  const refusal = (args: Partial<Parameters<typeof reconcileGitleaksToml>[0]>) => {
    const v = reconcileGitleaksToml({
      sourceToml: PRIME_TOML,
      cloneToml,
      ownRef: CLONE,
      registeredRef: CLONE,
      source: prime,
      ...args,
    });
    return v.ok ? null : v.reason;
  };

  it("refuses without this clone's own project", () => {
    expect(refusal({ ownRef: null })).toMatch(/own project could not be read/);
  });

  it("refuses where the file and the registry disagree", () => {
    expect(refusal({ registeredRef: PARENT })).toMatch(/registered backend/);
  });

  it("never guesses the own key: none, or two", () => {
    expect(refusal({ cloneToml: PRIME_TOML })).toMatch(/allows no key for its own project/);
    const two = appendOwnKeyAllowlist(cloneToml, CLONE, jwt(CLONE).replace("sig-", "rotated-"));
    expect(refusal({ cloneToml: two })).toMatch(/2 different keys for its own project/);
  });

  it("never writes an allowance for a key that bypasses RLS", () => {
    const serviceRole = appendOwnKeyAllowlist(PRIME_TOML, CLONE, jwt(CLONE, "service_role"));
    expect(refusal({ cloneToml: serviceRole })).toMatch(/not an anon key \(role `service_role`\)/);
  });

  it("refuses a parent it cannot name, or one that names this clone", () => {
    expect(refusal({ source: { kind: "deployment", ownRef: null } })).toMatch(
      /source deployment's own project could not be read/,
    );
    expect(refusal({ source: { kind: "deployment", ownRef: CLONE } })).toMatch(
      /names this clone's own project/,
    );
  });

  it("refuses to edit a key that shares its line with another value", () => {
    const sourceToml = `[[allowlists]]\nregexes = [${q}${PARENT_KEY}${q}, ${q}^x$${q}]\n`;
    expect(refusal({ sourceToml, source: parent })).toMatch(/shares its line/);
  });

  it("refuses where taking the key out would widen its block to a path allowance", () => {
    const sourceToml = [
      "[[allowlists]]",
      'condition = "AND"',
      `paths = [${q}^supabase/migrations/${q}]`,
      "regexes = [",
      `  ${q}${PARENT_KEY}${q},`,
      "]",
      "",
    ].join("\n");
    expect(refusal({ sourceToml, source: parent })).toMatch(
      /also has `condition`, `paths`, and taking it out would leave that block allowing more/,
    );
  });

  it("refuses where a key it takes out is still named somewhere it does not edit", () => {
    const sourceToml = `${PARENT_TOML}\n[[allowlists]]\ndescription = "Once ${PARENT_KEY}."\nregexes = [${q}^y$${q}]\n`;
    expect(refusal({ sourceToml, source: parent })).toMatch(
      /still names a key for `qvuwrvwzjyigptmnijyb`/,
    );
  });

  it("names an array it could not read as not read, rather than as carried", () => {
    const odd = `${cloneToml}\n[[allowlists]]\ndescription = "Odd."\nregexes = [\n  ${q}^z$${q} + 1,\n]\n`;
    const v = reconcileGitleaksToml({
      sourceToml: PRIME_TOML,
      cloneToml: odd,
      ownRef: CLONE,
      registeredRef: null,
      source: prime,
    });
    if (!v.ok) throw new Error(v.reason);
    expect(v.allowancesDropped).toEqual([{ description: "Odd.", values: null }]);
  });
});

describe("supabaseKeysAllowed — the reader", () => {
  it("reads a key written with escaped or bare dots, anchored or not, as the token", () => {
    const toml = [
      "[[allowlists]]",
      "regexes = [",
      `  ${q}${escaped(PRIME_KEY)}${q},`,
      `  ${q}^${CLONE_KEY}$${q},`,
      "]",
    ].join("\n");
    expect(supabaseKeysAllowed(toml).map((k) => [k.ref, k.key])).toEqual([
      [PRIME, PRIME_KEY],
      [CLONE, CLONE_KEY],
    ]);
  });

  it("is not fooled by a JWT-shaped pattern or a key in a comment", () => {
    const toml = [
      `# ${CLONE_KEY}`,
      "[[allowlists]]",
      "regexes = [",
      `  ${q}^eyJhbGciOiJIUzI1NiJ9\\.[A-Za-z0-9_.-]+$${q},`,
      `  ${q}^eyJ[A-Za-z0-9_-]{4,}\\.[A-Za-z0-9_-]+$${q},`,
      "]",
    ].join("\n");
    expect(supabaseKeysAllowed(toml)).toEqual([]);
  });
});

describe("gitleaksAllowsKey — provisioning's idempotence", () => {
  it("knows a key written with escaped dots, so provisioning does not stack a second block", () => {
    const toml = keyBlock("Own.", escaped(CLONE_KEY));
    expect(gitleaksAllowsKey(toml, CLONE_KEY)).toBe(true);
    expect(appendOwnKeyAllowlist(toml, CLONE, CLONE_KEY)).toBe(toml);
  });
});
