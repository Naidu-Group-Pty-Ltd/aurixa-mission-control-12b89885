#!/usr/bin/env node
// Four failures that produce no runtime signal, on the deployment path.
//
// 1. A SECRET GIVEN A PUBLIC NAME.
//
//    Vite inlines every `VITE_`-prefixed variable into the client bundle at
//    build time. Marking it "encrypted" on the hosting provider protects it at
//    rest and not at all in the artefact — the value is a string literal in the
//    JavaScript every visitor downloads. Give the Supabase SERVICE-ROLE key a
//    `VITE_` name and the build succeeds, the deployment goes live, and a key
//    that bypasses every RLS policy on a customer's database is served to the
//    public. Nothing fails. Nothing logs.
//
//    `envPolicy.pure.ts` throws at runtime, which covers everything that goes
//    through `buildCloneEnv`. This covers the other half: a literal somebody
//    writes into a component, a script, or a second env builder that never
//    imports the policy.
//
// 2. AN ENVIRONMENT THAT NAMES SOMEBODY ELSE'S BACKEND.
//
//    `buildCloneEnv` refuses a pair that names the prime — but only when it is
//    TOLD which project the prime is. `primeProjectRef` is an optional input by
//    design (a deployment that has not configured a prime still gets the pairing
//    checks), so an edit that drops the argument at the call site turns the
//    strongest half of the rule off with no test failing and no runtime signal:
//    the environment is still built, still published, still coherent — just no
//    longer checked against the one project it must never be.
//
//    This is the class the deployed client dashboard already demonstrated. Its
//    hosting project never had `VITE_SUPABASE_URL` at all, its build fell
//    through to a fallback that was the prime, and it served the prime's
//    production database on a custom domain for a week with nothing failing.
//
// 3. A STATUS THE COLUMN WILL REFUSE.
//
//    `clone_deployments.status` has a CHECK constraint and the worker's state
//    machine lives in TypeScript. When they drift, the update fails with
//    `violates check constraint` — and this codebase has a long history of
//    discarding the error from a Supabase call, which turns a refused write into
//    a row that silently never advances. Same class as a table missing from the
//    generated types.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PUBLIC_PREFIXES = ["VITE_", "NEXT_PUBLIC_", "PUBLIC_", "REACT_APP_"];
const SECRET_FRAGMENTS = [
  "SERVICE_ROLE",
  "SERVICE_KEY",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "PRIVATE_KEY",
  "ACCESS_TOKEN",
  "API_TOKEN",
  "CLIENT_SECRET",
  "WEBHOOK_SECRET",
  "DB_PASS",
  "DATABASE_URL",
  "CONNECTION_STRING",
];

// The policy module names these fragments in order to REFUSE them, and its test
// file spells them out to prove the refusal. Both are the rule, not a breach.
const EXEMPT_FILES = new Set([
  "src/server/hosting/envPolicy.pure.ts",
  "src/server/hosting/envPolicy.test.ts",
]);

const failures = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const st = statSync(path);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === ".git") continue;
      walk(path);
      continue;
    }
    if (!/\.(ts|tsx|mjs|cjs|js)$/.test(entry)) continue;
    if (EXEMPT_FILES.has(path)) continue;
    const src = readFileSync(path, "utf8");
    // Whole identifiers only: a prefix followed by name characters.
    for (const m of src.matchAll(/\b((?:VITE_|NEXT_PUBLIC_|PUBLIC_|REACT_APP_)[A-Z0-9_]+)\b/g)) {
      const name = m[1];
      const fragment = SECRET_FRAGMENTS.find((f) => name.includes(f));
      if (!fragment) continue;
      const line = src.slice(0, m.index).split("\n").length;
      failures.push(
        `${path}:${line}  ${name} — public prefix carrying "${fragment}". ` +
          `A value that grants authority cannot have a name the bundler inlines.`,
      );
    }
  }
}

walk("src");
if (PUBLIC_PREFIXES.length === 0) throw new Error("unreachable");

// ── The prime ref reaches the policy ───────────────────────────────────────
{
  const DRAIN = "src/routes/hooks.deployment-drain.tsx";
  const src = readFileSync(DRAIN, "utf8");
  // The call, from `buildCloneEnv(` to its closing `});`. Matching the whole
  // call rather than searching the file for the identifier is what makes this
  // specific: `primeProjectRef` mentioned anywhere else in the module is not
  // evidence that it is passed HERE.
  const call = src.match(/buildCloneEnv\(\{([\s\S]*?)\n\s*\}\)/);
  if (!call) {
    failures.push(
      `${DRAIN}  could not find the buildCloneEnv({...}) call. If the deployment ` +
        `worker was restructured, update this check with it — a check that cannot ` +
        `find its subject silently stops checking.`,
    );
  } else {
    if (!/\bprimeProjectRef\b/.test(call[1])) {
      failures.push(
        `${DRAIN}  builds a clone environment without passing primeProjectRef. ` +
          `buildCloneEnv can only refuse an environment that names the prime's ` +
          `backend when it is told which project that is, so dropping this argument ` +
          `turns the rule off with nothing failing. Resolve it with ` +
          `resolvePrimeBackendRef() and pass it in.`,
      );
    }
    // 4. A CLONE WHOSE BUNDLE SPENDS SOMEBODY ELSE'S ACCOUNT.
    //
    // `VITE_AURIXA_BILLING_UID` is the same shape of omission with money on
    // it. The prime's bundle compiles in `npc-prime` as its own fallback, and
    // a clone built without one of its own falls through to exactly that —
    // so a customer's "buy more tokens" credits the PRIME's balance. Nothing
    // fails: the build is green, the link works, the money moves.
    //
    // The field is optional on `buildCloneEnv` (a clone that has no identity
    // yet must still deploy), so only the call site can assert it is offered.
    if (!/\bbillingUserId\b/.test(call[1])) {
      failures.push(
        `${DRAIN}  builds a clone environment without passing billingUserId. ` +
          `Vite inlines VITE_* at BUILD time, so an identity that is not in the ` +
          `environment here is one the bundle does not have — and the clone then ` +
          `falls back to the prime's built-in uid, crediting the prime for its own ` +
          `customers' purchases. Read clones.billing_user_id and pass it in.`,
      );
    }
  }
}

// ── 5. Provisioning must not write a clone with no billing identity ────────
//
// `billing_user_id: data.billingUserId ?? null` is what this was, and it is
// why every clone in the fleet carried NULL: the wizard's field defaults
// blank. The insert goes through `resolveCloneBillingIdForProvisioning`, which
// derives one from the slug when nobody named one and refuses an id a tenant
// already holds.
{
  const PROV = "src/server/clone-provisioning.server.ts";
  const src = readFileSync(PROV, "utf8");
  const line = src.match(/^\s*billing_user_id:.*$/m);
  if (!line) {
    failures.push(
      `${PROV}  no billing_user_id written on the clone insert. A clone with no ` +
        `billing identity has no way for its customers to pay — see ` +
        `src/server/cloneBillingIdentity.pure.ts.`,
    );
  } else if (/data\.billingUserId/.test(line[0])) {
    failures.push(
      `${PROV}  writes the operator's billingUserId straight onto the clone. It ` +
        `must go through resolveCloneBillingIdForProvisioning(), which derives one ` +
        `from the slug when the field is blank (which it is by default) and refuses ` +
        `an id a tenant already holds — a clone holding a tenant's id SHADOWS it, ` +
        `because startUidCheckout resolves a uid against clones before tenants.`,
    );
  }
}

// ── 6. The shadow check never reads through the caller's client ────────────
//
// Finding the row that WOULD be shadowed is the whole job, and RLS FILTERS
// rather than erroring — so a read the caller cannot see answers `{ data:
// null, error: null }`, which reads as "nobody holds it": exactly the answer
// that lets a shadowing id through. `supabaseAdmin` is the default on every
// function in the module and the `db` parameter is the test double's; a
// production call site that passes its own client has quietly narrowed a
// safety check to whatever that session can see.
{
  const IDENT = "src/server/clone-billing-identity.server.ts";
  const src = readFileSync(IDENT, "utf8");
  for (const fn of [
    "billingIdHolders",
    "checkCloneBillingId",
    "resolveCloneBillingIdForProvisioning",
    "setCloneBillingId",
    "ensureCloneBillingIdForDeployment",
  ]) {
    const sig = src.match(new RegExp(`export async function ${fn}\\(([\\s\\S]*?)\\):`));
    if (!sig) {
      failures.push(`${IDENT}  ${fn} not found. If it was renamed, update this check with it.`);
    } else if (!/db:\s*Db\s*=\s*supabaseAdmin/.test(sig[1])) {
      failures.push(
        `${IDENT}  ${fn} does not default its client to supabaseAdmin. The holder lookup ` +
          `is a safety check and RLS filters rather than erroring, so a read the caller ` +
          `cannot see reports "nobody holds it" — the one answer that lets a clone be ` +
          `given an id a tenant already holds.`,
      );
    }
  }
  // The deployment worker is a caller too: it heals a clone that reaches
  // `syncing_env` with no identity, through the same lookup. Its client is
  // named `admin`, which is why that name is on the list below — a check that
  // only knows the names other files use cannot see this one pass its own.
  for (const CALLER of [
    "src/server/clone-provisioning.server.ts",
    "src/server/clone-billing-identity.functions.ts",
    "src/routes/hooks.deployment-drain.tsx",
  ]) {
    const caller = readFileSync(CALLER, "utf8");
    const passing = caller.match(
      /\b(?:billingIdHolders|checkCloneBillingId|resolveCloneBillingIdForProvisioning|ensureCloneBillingIdForDeployment)\([\s\S]{0,400}?\)/g,
    );
    for (const call of passing ?? []) {
      if (/\b(?:supabase|supabaseAdmin|admin|db)\b\s*(?:,|\))/.test(call)) {
        failures.push(
          `${CALLER}  passes a client into the billing-identity lookup:\n    ` +
            `${call.split("\n")[0].trim()}\n  Leave it off. The default is supabaseAdmin and ` +
            `the parameter is the test double's — a caller-scoped read cannot see the row ` +
            `it exists to find.`,
        );
      }
    }
  }
}

// ── 7. The worker heals a missing identity before it publishes ─────────────
//
// Provisioning resolves an identity before the clone row is written, but its
// resolution never throws — a control plane it could not read inserts the
// clone with NULL and a note in a log. The worker is where every build is
// made, so it is where the gap has to close: it must resolve through
// `ensureCloneBillingIdForDeployment`, and publish what THAT returns rather
// than the column it read before the heal.
{
  const DRAIN = "src/routes/hooks.deployment-drain.tsx";
  const src = readFileSync(DRAIN, "utf8");
  if (!/\bensureCloneBillingIdForDeployment\(/.test(src)) {
    failures.push(
      `${DRAIN}  never calls ensureCloneBillingIdForDeployment. A clone that reaches ` +
        `syncing_env with no billing identity is then built with none, and nothing ` +
        `retries the derivation — see src/server/clone-billing-identity.server.ts.`,
    );
  }
  if (/const\s+billingUserId\s*=\s*clone\.billing_user_id\b/.test(src)) {
    failures.push(
      `${DRAIN}  publishes clone.billing_user_id as read before the heal. Publish ` +
        `the identity ensureCloneBillingIdForDeployment returns, or a healed clone's ` +
        `first build still ships without one.`,
    );
  }
}

// ── Status parity ──────────────────────────────────────────────────────────
const MIGRATIONS = "supabase/migrations";
const sql = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
  .join("\n")
  .replace(/--[^\n]*/g, "");

// Scoped to the clone_deployments table body. Searching the whole migration
// corpus for `status ... check (status in (...))` finds the FIRST such column in
// any table — which was clone_edge_config, whose states are waitlisted/pending_ns
// /active/drifted. A parity check that silently compares the wrong two lists is
// worse than none: it fails loudly on correct code and passes on the drift it
// exists to catch.
const tableMatch = sql.match(
  /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.clone_deployments\s*\(([\s\S]*?)\n\);/i,
);
const checkMatch = tableMatch
  ? tableMatch[1].match(/status\s+text\s+not\s+null[^,]*?check\s*\(status\s+in\s*\(([^)]*)\)/i)
  : null;
if (!checkMatch) {
  failures.push(
    "supabase/migrations  could not find the clone_deployments.status CHECK constraint. " +
      "If the column was renamed or the constraint reshaped, update this check with it — " +
      "a parity check that cannot find its subject silently stops checking.",
  );
} else {
  const dbStatuses = new Set([...checkMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const tsSrc = readFileSync("src/server/hosting/deploymentState.pure.ts", "utf8");
  const tsMatch = tsSrc.match(/DEPLOYMENT_STATUSES\s*=\s*\[([^\]]*)\]/);
  const tsStatuses = new Set(
    tsMatch ? [...tsMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [],
  );

  for (const s of tsStatuses) {
    if (!dbStatuses.has(s)) {
      failures.push(
        `deploymentState.pure.ts declares status "${s}" that clone_deployments.status refuses. ` +
          `The update fails with "violates check constraint" and the row never advances.`,
      );
    }
  }
  for (const s of dbStatuses) {
    if (!tsStatuses.has(s)) {
      failures.push(
        `clone_deployments.status accepts "${s}" that deploymentState.pure.ts does not declare. ` +
          `A row in that state is claimable by nothing and readable as nothing.`,
      );
    }
  }
}

// 4. A SUBDOMAIN STATUS THE COLUMN WILL REFUSE.
//
//    Same class as (3) and it has already bitten once on this path:
//    `awaiting_deployment` was written by three call sites before the CHECK
//    constraint knew about it. Every one of those call sites discards the error
//    from the update, so the write failed and the clone simply stayed in its
//    previous state — a subdomain that never progresses, with nothing logged
//    anywhere and no failed request to find.
//
//    The constraint is amended by a later migration rather than living in the
//    CREATE TABLE, so this reads the LAST definition in the corpus. Reading the
//    first would compare against a list that was correct eight months ago.
{
  const constraintDefs = [
    ...sql.matchAll(
      /clones_subdomain_status_check\s*\n?\s*check\s*\(\s*subdomain_status\s+is\s+null\s+or\s+subdomain_status\s+in\s*\(([^)]*)\)/gi,
    ),
  ];
  if (constraintDefs.length === 0) {
    failures.push(
      "supabase/migrations  could not find the clones_subdomain_status_check constraint. " +
        "A parity check that cannot find its subject silently stops checking.",
    );
  } else {
    const allowed = new Set(
      [...constraintDefs[constraintDefs.length - 1][1].matchAll(/'([^']+)'/g)].map((m) => m[1]),
    );
    // Every literal the application assigns to the column, wherever it lives.
    const written = new Map();
    const collect = (dir) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        const st = statSync(path);
        if (st.isDirectory()) {
          if (entry === "node_modules" || entry === ".git") continue;
          collect(path);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        const src = readFileSync(path, "utf8");
        // The ternary form first: `ready ? "queued" : "pending_platform"` also
        // matches the plain pattern on its first branch, so running the simple
        // one first would record only half of it.
        for (const m of src.matchAll(
          /subdomain_status:\s*[^,\n]*?\?\s*"([^"]+)"\s*:\s*"([^"]+)"/g,
        )) {
          if (!written.has(m[1])) written.set(m[1], path);
          if (!written.has(m[2])) written.set(m[2], path);
        }
        for (const m of src.matchAll(/subdomain_status:\s*"([^"]+)"/g)) {
          if (!written.has(m[1])) written.set(m[1], path);
        }
      }
    };
    collect("src");
    for (const [value, file] of written) {
      if (!allowed.has(value)) {
        failures.push(
          `${file}  writes clones.subdomain_status = "${value}", which the CHECK constraint ` +
            `refuses. The update fails with "violates check constraint", the error is discarded, ` +
            `and the clone silently keeps its previous status.`,
        );
      }
    }
  }
}

if (failures.length) {
  console.error("\n✗ Hosting policy check failed:\n");
  for (const f of failures) console.error("  " + f);
  console.error("");
  process.exit(1);
}

console.log(
  "✓ No secret carries a public env prefix, no clone environment can be built without\n" +
    "  checking it against the prime, and the deployment state machine matches the column.",
);
