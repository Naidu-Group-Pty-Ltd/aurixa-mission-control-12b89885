# Prime Repo — Mission Control Token Metering Integration

Drop-in instructions for the prime repo coding agent. Mission Control owns all
balances, plans, top-ups, and ledgers. The prime repo only **reserves** tokens
before generating a report and **commits** (or **cancels**) when it finishes.

## 1. Secrets (set in prime repo)

| Name                            | Value                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| `MISSION_CONTROL_URL`           | `https://aurixa-mission-control.lovable.app`                                           |
| `MISSION_CONTROL_CLONE_API_KEY` | Issue in Mission Control → Settings → Billing & Tokens → API Keys. Starts with `mck_`. |

## 2. Client module — `src/server/tokens.client.ts`

```typescript
const BASE = process.env.MISSION_CONTROL_URL!;
const KEY = process.env.MISSION_CONTROL_CLONE_API_KEY!;

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-clone-api-key": KEY,
      ...(init.headers ?? {}),
    },
  });
  const json = (await res.json()) as T & { ok?: boolean; error?: string };
  if (!res.ok || json.ok === false) {
    throw new Error(`tokens:${path} ${res.status} ${json.error ?? "failed"}`);
  }
  return json;
}

export type ReserveResult = {
  ok: true;
  job_id: string;
  reserved_tokens: number;
  available_after: number;
  idempotent?: boolean;
  status?: string;
};

export function reserveTokens(input: {
  tenantRef: string; // stable user/org id from prime app
  displayName?: string;
  kind: string; // e.g. "report.full", "report.summary"
  estimatedTokens: number;
  idempotencyKey: string; // deterministic per logical report attempt
  ttlSeconds?: number;
  requestPayload?: Record<string, unknown>;
}) {
  return call<ReserveResult>("/api/public/tokens/reserve", {
    method: "POST",
    body: JSON.stringify({
      tenant_ref: input.tenantRef,
      display_name: input.displayName,
      kind: input.kind,
      estimated_tokens: input.estimatedTokens,
      idempotency_key: input.idempotencyKey,
      ttl_seconds: input.ttlSeconds,
      request_payload: input.requestPayload,
    }),
  });
}

export function commitTokens(input: {
  jobId: string;
  actualTokens: number;
  resultMeta?: Record<string, unknown>;
}) {
  return call<{ ok: true; charged_tokens: number; available_after: number }>(
    "/api/public/tokens/commit",
    {
      method: "POST",
      body: JSON.stringify({
        job_id: input.jobId,
        actual_tokens: input.actualTokens,
        result_meta: input.resultMeta,
      }),
    },
  );
}

export function cancelTokens(input: { jobId: string; reason?: string }) {
  return call<{ ok: true }>("/api/public/tokens/cancel", {
    method: "POST",
    body: JSON.stringify({ job_id: input.jobId, reason: input.reason }),
  });
}

export function getBalance(tenantRef: string, displayName?: string) {
  const q = new URLSearchParams({ tenant_ref: tenantRef });
  if (displayName) q.set("display_name", displayName);
  return call<{
    ok: true;
    tenant: {
      current_period_end: string | null;
      billing_plans: { name: string; monthly_allowance: number; overage_policy: string } | null;
    };
    balance: {
      available: number;
      reserved: number;
      lifetime_granted: number;
      lifetime_spent: number;
    };
    // Price-list slugs. See §4a.
    entitlements: {
      addons: string[];
      excluded?: string[];
    };
  }>(`/api/public/tokens/balance?${q.toString()}`, { method: "GET" });
}
```

## 3. Report generation pattern

Wrap **every** report entry point with reserve → generate → commit/cancel.

```typescript
import { reserveTokens, commitTokens, cancelTokens } from "@/server/tokens.client";

export async function generateReport(params: {
  userId: string; // tenantRef
  reportRequestId: string; // stable id for this attempt
  inputs: ReportInputs;
}) {
  const estimate = estimateTokens(params.inputs); // your heuristic

  const reservation = await reserveTokens({
    tenantRef: params.userId,
    kind: "report.full",
    estimatedTokens: estimate,
    idempotencyKey: `report:${params.reportRequestId}`,
    requestPayload: { inputs_summary: summarize(params.inputs) },
  });

  try {
    const { report, usage } = await runReportPipeline(params.inputs);

    await commitTokens({
      jobId: reservation.job_id,
      actualTokens: usage.totalTokens, // real spend
      resultMeta: { pages: report.pages, model: usage.model },
    });

    return report;
  } catch (err) {
    await cancelTokens({
      jobId: reservation.job_id,
      reason: err instanceof Error ? err.message.slice(0, 280) : "generation_failed",
    }).catch(() => {}); // best-effort; reservation auto-expires after TTL
    throw err;
  }
}
```

### Rules

- **`idempotencyKey` must be deterministic** for a given logical attempt — retrying with the same key returns the existing job instead of double-charging.
- **`tenantRef`** = your stable user or org id. Mission Control auto-provisions the tenant on first call and grants the default plan's monthly allowance.
- **Always commit or cancel.** Uncommitted reservations auto-release after `ttl_seconds` (default 600), but explicit cancel frees balance immediately.
- **`actualTokens` may exceed the reservation** — Mission Control honors it (subject to plan overage policy). Reserve generously when uncertain.

## 4. Pre-flight balance banner (optional but recommended)

On session load (or in your report intake form):

```typescript
const { balance, tenant } = await getBalance(userId);
const allowance = tenant.billing_plans?.monthly_allowance ?? 0;
const lowThreshold = allowance * 0.1;

if (balance.available < lowThreshold) {
  showBanner({
    text: `Only ${balance.available.toLocaleString()} tokens left this period.`,
    action: { label: "Manage subscription", href: "<billing url>" },
  });
}
```

### 4a. Entitlements

A clone gates its features on this response and on nothing else Mission
Control holds. `entitlements` is in price-list slugs (`MODULES[].slug` in
Mission Control's `src/lib/pricing/aurixa-catalog.ts`):

```
entitlements: { addons: string[], excluded?: string[] }
```

- `addons` — the add-ons the clone holds, plus `aml-ctf` on a known tier unless
  a without-AML SKU is recorded. It never contains an excluded slug.
  - For a billing-exempt tenant (`tenant.billing_exempt`, only the prime's), it
    is every slug on the price list, less the exclusions. Cache it as you cache
    any other answer: the cached list is what lets an exempt workspace keep its
    add-on-only modules through an outage. Never cache the exemption itself,
    which also waives metering.
- `excluded` — what the clone's signed agreement took out of its tier, sorted
  and de-duplicated. It is present, possibly `[]`, whenever Mission Control
  read the clone's row, and `[]` for a platform-level key, which has no clone.
  It is absent only when that read failed. Keep the exclusions last received
  then: absent means "not known", never "none".

Subtract `excluded` from what the plan and the add-ons grant. A failed read
never fails the balance call.

## 5. Out of scope for the prime repo

Do **not** build plans, top-up packs, payment UI, ledger views, or refunds in
the prime repo. All of that lives in Mission Control. The prime repo's only
billing surface is: pre-flight balance check + post-report receipt.

## 6. Error handling

| Error from Mission Control             | Meaning                                      | Prime repo action                                                         |
| -------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------- |
| `unauthorized` (401)                   | Bad/revoked `x-clone-api-key`                | Page on-call; do not retry.                                               |
| `insufficient_funds` (200, `ok:false`) | Balance < estimate, plan blocks overage      | Show "Out of tokens — top up" CTA; do not start the report. See §7.       |
| `job_not_found` / `forbidden`          | Job from a different clone                   | Bug — log and surface.                                                    |
| `invalid_input` (400)                  | Schema mismatch                              | Bug — log payload.                                                        |
| Network/5xx on commit                  | Mission Control unreachable after generation | Retry commit with same `job_id` (commit is idempotent on completed jobs). |

## 7. Out-of-tokens UI flow

When `reserveTokens` rejects with `insufficient_funds`, the response body is:

```json
{ "ok": false, "error": "insufficient_funds", "available": 240, "required": 1500 }
```

Surface this as a dedicated state — never a generic toast.

### 7a. Typed error class

Update `tokens.client.ts` so callers can `instanceof`-check the failure:

```typescript
export class InsufficientTokensError extends Error {
  constructor(
    public available: number,
    public required: number,
  ) {
    super(`insufficient_funds: have ${available}, need ${required}`);
    this.name = "InsufficientTokensError";
  }
}

// inside `call()`:
if (json.ok === false && json.error === "insufficient_funds") {
  throw new InsufficientTokensError((json as any).available ?? 0, (json as any).required ?? 0);
}
```

### 7b. Intake-form guard

```tsx
import { InsufficientTokensError } from "@/server/tokens.client";
import { OutOfTokensBanner } from "@/components/out-of-tokens-banner";

const [outOfTokens, setOutOfTokens] = useState<{ available: number; required: number } | null>(
  null,
);

async function onSubmit() {
  setOutOfTokens(null);
  try {
    const report = await generateReport({ userId, reportRequestId, inputs });
    // …
  } catch (err) {
    if (err instanceof InsufficientTokensError) {
      setOutOfTokens({ available: err.available, required: err.required });
      return; // do NOT show a generic error toast
    }
    toast.error("Report generation failed");
  }
}

return (
  <>
    {outOfTokens && (
      <OutOfTokensBanner available={outOfTokens.available} required={outOfTokens.required} />
    )}
    <ReportForm onSubmit={onSubmit} />
  </>
);
```

### 7c. Banner component

```tsx
// src/components/out-of-tokens-banner.tsx
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "@tanstack/react-router";

export function OutOfTokensBanner({
  available,
  required,
}: {
  available: number;
  required: number;
}) {
  const short = (required - available).toLocaleString();
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4"
    >
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
      <div className="flex-1">
        <p className="font-semibold text-destructive">Out of report credits</p>
        <p className="mt-1 text-sm text-muted-foreground">
          This report needs <strong>{required.toLocaleString()}</strong> tokens but you only have{" "}
          <strong>{available.toLocaleString()}</strong> available — you're short by{" "}
          <strong>{short}</strong>.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button asChild>
            <Link to="/billing/topup">Top up credits</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/billing">Upgrade plan</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
```

### 7d. Pre-flight guard (avoid the error entirely)

Before showing the report intake form, call `getBalance(userId)` and disable
the "Generate report" CTA when `balance.available < estimateTokens(form)`. Pair
with the same banner so the messaging is identical. The 401-style fallback in
`onSubmit` then only fires for race conditions (concurrent reports draining
balance between pre-flight and reserve).

## 8. Idempotency contract

| Endpoint  | Idempotency key                                                  | Behavior on replay                                                                                                                                               |
| --------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reserve` | `(clone_id, idempotency_key)` — pass via `idempotency_key` field | Returns the existing `job_id` and reservation with `idempotent: true` instead of double-reserving. Use the **same key** for retries of the same logical attempt. |
| `commit`  | `job_id`                                                         | If the job is already `completed`, returns the original `charged_tokens` with `idempotent: true` — never double-charges. Safe to retry on network/5xx.           |
| `cancel`  | `job_id`                                                         | No-op if the job is not in `reserved` state; returns `ok: true` regardless.                                                                                      |

**Rule of thumb:** retries with the same `idempotency_key` / `job_id` are
always safe. Generating a new key for a retry creates a new charge.

## 9. Rate limiting

All `/api/public/tokens/*` endpoints are rate-limited per API key. Default:
**60 requests / minute / key**. Responses include:

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 42
```

When exceeded the server returns **HTTP 429** with:

```
Retry-After: 37
Content-Type: application/json

{ "ok": false, "error": "rate_limited", "count": 73, "limit": 60, "retry_after_seconds": 37 }
```

Clients should honour `Retry-After` (seconds) and back off. Reserve calls
that hit the limit do **not** consume tokens — safe to retry after the
window resets.

## 10. Webhooks (Mission Control → prime repo)

Mission Control fires webhooks for administrative or asynchronous events
the prime repo cannot observe via the synchronous reserve/commit path.

### 10a. Events

| Event                    | Fired when                                                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tokens.balance.updated` | A reserve/commit/cancel/grant/topup/refund changed the tenant balance. Payload includes the latest `{ tenant, balance }` snapshot.                             |
| `tokens.key.rotated`     | An admin rotated an API key. Payload includes `{ key_id, old_prefix, new_prefix, revoke_at }` so the prime repo can swap secrets before the grace period ends. |
| `tokens.key.revoked`     | A key was revoked (manually or by scheduled rotation).                                                                                                         |
| `tokens.alert`           | Threshold alert (80%/100% allowance), cancel-rate spike, or first-use of a key.                                                                                |

### 10b. Configuring an endpoint

Mission Control admins register endpoints under **Settings → Billing &
Tokens → Webhooks**. Each endpoint gets a per-endpoint signing secret —
treat it as sensitive and store in the prime repo as `MISSION_CONTROL_WEBHOOK_SECRET`.

### 10c. Verifying signatures

Every delivery includes these headers:

```
x-mc-event:     tokens.balance.updated
x-mc-signature: <hex hmac-sha256 of the raw request body using the endpoint secret>
```

Verify before processing — never trust the payload otherwise.

```typescript
// src/routes/api/webhooks/mission-control.ts (prime repo)
import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "crypto";

export const Route = createFileRoute("/api/webhooks/mission-control")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.MISSION_CONTROL_WEBHOOK_SECRET!;
        const signature = request.headers.get("x-mc-signature");
        const event = request.headers.get("x-mc-event");
        const raw = await request.text();

        const expected = createHmac("sha256", secret).update(raw).digest("hex");
        if (
          !signature ||
          signature.length !== expected.length ||
          !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
        ) {
          return new Response("invalid_signature", { status: 401 });
        }

        const { data } = JSON.parse(raw) as { event: string; data: any };

        switch (event) {
          case "tokens.balance.updated":
            await cacheBalance(data.tenant.external_ref, data.balance);
            break;
          case "tokens.key.rotated":
            await scheduleKeySwap(data.new_prefix, data.revoke_at);
            break;
          case "tokens.key.revoked":
            await alertOnCall(`MC key ${data.key_id} revoked`);
            break;
          case "tokens.alert":
            await notifyOps(data);
            break;
        }
        return new Response("ok");
      },
    },
  },
});
```

### 10d. Delivery semantics

- **At-least-once.** Mission Control retries failed deliveries with exponential
  backoff (1m, 2m, 4m, … capped at 6h) up to 6 attempts. Make handlers
  idempotent — keyed on `data.tenant.id` + `event` is usually enough.
- **Best-effort ordering.** Out-of-order arrival is possible during retries —
  always trust the most recent `balance.updated` snapshot, not deltas.
- **Timeouts.** Endpoints must respond within 8s or the delivery is recorded
  as failed and retried.

## 11. Top-up purchase flow

When `reserveTokens` rejects with `insufficient_funds`, surface the
`OutOfTokensBanner` (see §7c) — but instead of linking to a prime-repo
`/billing/topup` page, deep-link the user to Mission Control's hosted
top-up page so an admin can apply credits in seconds.

### 11a. Fetch packs (optional)

If you want to render plan options inline (e.g. "Buy 50k tokens for $25"),
call the public catalogue endpoint:

```typescript
export function listTopupPacks(tenantRef: string, opts?: { limit?: number; offset?: number }) {
  const q = new URLSearchParams({ tenant_ref: tenantRef });
  if (opts?.limit) q.set("limit", String(opts.limit)); // default 50, max 100
  if (opts?.offset) q.set("offset", String(opts.offset));
  return call<{
    ok: true;
    packs: Array<{
      id: string;
      slug: string;
      name: string;
      tokens: number;
      price_cents: number;
      currency: string;
      expires_after_days: number | null;
    }>;
    topup_url: string | null; // deep link into Mission Control
    pagination: {
      limit: number;
      offset: number;
      total: number;
      has_more: boolean;
      next_offset: number | null;
    };
  }>(`/api/public/tokens/packs?${q.toString()}`, { method: "GET" });
}
```

The endpoint paginates server-side (default `limit=50`, max `100`) and
echoes `X-Total-Count`. Iterate with `next_offset` until `has_more` is
`false`. Combined with the standard rate-limit headers (`X-RateLimit-*`),
this scales to large pack catalogues without surprises.

### 11a-bis. Test webhook deliveries

Mission Control's Settings → Billing → Webhooks tab exposes a **Test**
button on every endpoint. It POSTs a synthetic `tokens.test` event with a
fresh `x-mc-idempotency-key` header so you can verify both your HMAC
signature check and your receiver's idempotency handling without touching
real balances. The payload shape mirrors production events; receivers
should accept `event === "tokens.test"` as a no-op success.

### 11b. CTA wiring

Replace the placeholder `/billing/topup` link in `OutOfTokensBanner` with
the `topup_url` returned by `listTopupPacks(userId)`:

```tsx
const { packs, topup_url } = await listTopupPacks(userId);

<Button asChild>
  <a href={topup_url ?? `${MISSION_CONTROL_URL}/billing/topup`} target="_blank" rel="noreferrer">
    Top up credits
  </a>
</Button>;
```

The Mission Control `/billing/topup` page is authenticated — only operators
with billing access can apply a top-up. End-users without MC access should
be routed to an in-app "Contact billing" workflow that pages an admin.

The page ships with built-in search, currency/min-tokens/max-price filters,
sort controls, and **paginated pack cards** (page-size selector + First /
Prev / Next / Last controls). For programmatic consumers, the underlying
`/api/public/tokens/packs` endpoint paginates server-side via `limit` /
`offset` (see §11a).

### 11c. Refresh balance after top-up

Top-ups fire a `tokens.balance.updated` webhook (see §10). If you've wired
the webhook handler, balance caches auto-invalidate. Otherwise, re-call
`getBalance(userId)` when the user returns to the report intake page.
