/**
 * The lateral lane, as the Yggdrasil diagram and an operator reach it.
 *
 * Three doors and no more. Reading the ledger asks GitHub nothing, so the
 * panel costs no installation calls however often it is opened. Running a
 * pass and pausing the boundary both act on two deployments' repositories, so
 * both require an operator — the same role that may approve a cascade.
 *
 * Every rule lives in `cascade/lateralExchange.pure.ts` and every read and
 * write in `lateral-exchange.server.ts`; nothing is decided here.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireOperator } from "@/integrations/supabase/role-middleware";
import {
  LATERAL_OPERATOR_BUDGET_MS,
  readLateralExchangeLedger,
  runLateralExchange,
  setLateralExchangePaused,
  type LateralExchangeReport,
  type LateralLedgerView,
} from "./lateral-exchange.server";

export type {
  LateralBoundaryReport,
  LateralDirectionReport,
  LateralExchangeReport,
  LateralLedgerView,
  LateralReconcile,
} from "./lateral-exchange.server";
// Types only, and so erased before the client bundle's import protection
// sees them: the panel names the outcomes it prints without reaching the
// module that decides them.
export type {
  LateralBoundaryOutcome,
  LateralDirectionOutcome,
  LateralMode,
  LateralReconcileState,
} from "./cascade/lateralExchange.pure";

/**
 * What the ledger says about every lateral boundary.
 *
 * Operator-only because `audit_log` is: its read policy admits operators, and
 * a view built on the service role for anyone signed in would show what the
 * table itself refuses them.
 */
export const readLateralExchange = createServerFn({ method: "GET" })
  .middleware([requireOperator])
  .handler(async (): Promise<LateralLedgerView[]> => readLateralExchangeLedger());

/**
 * Run a pass now, outside the slot. `dryRun` judges everything and writes
 * nothing — no pull request, no merge, no ledger row — and returns what a
 * real pass would have proposed.
 */
export const runLateralExchangeNow = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((d: { dryRun?: boolean }) =>
    z.object({ dryRun: z.boolean().optional() }).parse(d ?? {}),
  )
  .handler(
    async ({ data, context }): Promise<LateralExchangeReport> =>
      runLateralExchange({
        trigger: "operator",
        force: true,
        dryRun: data.dryRun === true,
        actorUserId: context.userId,
        deadlineAt: Date.now() + LATERAL_OPERATOR_BUDGET_MS,
      }),
  );

/**
 * Pause or resume every lateral boundary. Pausing also disarms GitHub's
 * auto-merge on the lane's open proposals; resuming re-arms nothing.
 */
export const setLateralExchangePausedFn = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((d: { paused: boolean }) => z.object({ paused: z.boolean() }).parse(d))
  .handler(async ({ data, context }) =>
    setLateralExchangePaused({ paused: data.paused, actorUserId: context.userId }),
  );
