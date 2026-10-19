// What `writeAuditLog` hands Postgres: `entity_id` is a uuid column, so a
// reference that is not a uuid must not reach it — Postgres refuses the whole
// row, and the record of what happened is lost.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Array<{ table: string; row: Record<string, unknown> }>,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        h.rows.push({ table, row });
        return { error: null };
      },
    }),
  },
}));

import { writeAuditLog } from "./audit.server";

beforeEach(() => {
  h.rows = [];
});

describe("writeAuditLog", () => {
  it("writes a uuid reference to entity_id unchanged", async () => {
    const id = "9296e1d7-ef44-4a9f-9277-5d1b7d2d4d85";
    await writeAuditLog({
      action: "codex_settings.updated",
      entityType: "prime_config",
      entityId: id,
      metadata: { codex_autofix_enabled: true },
    });
    expect(h.rows).toEqual([
      {
        table: "audit_log",
        row: {
          action: "codex_settings.updated",
          entity_type: "prime_config",
          entity_id: id,
          actor_user_id: null,
          metadata: { codex_autofix_enabled: true },
        },
      },
    ]);
  });

  it("accepts a uuid in capitals", async () => {
    await writeAuditLog({
      action: "x",
      entityType: "y",
      entityId: "9296E1D7-EF44-4A9F-9277-5D1B7D2D4D85",
    });
    expect(h.rows[0].row).toMatchObject({
      entity_id: "9296E1D7-EF44-4A9F-9277-5D1B7D2D4D85",
      metadata: {},
    });
  });

  it("moves a reference that is not a uuid into metadata, so the row is not refused", async () => {
    await writeAuditLog({
      action: "prime.stray_digest_proposal.retracted",
      entityType: "github_repository",
      entityId: "Naidu-Group-Pty-Ltd/npc-property-dashbord",
      metadata: { closed: [3316], branchDeleted: true },
    });
    expect(h.rows[0].row).toMatchObject({
      entity_id: null,
      metadata: {
        closed: [3316],
        branchDeleted: true,
        entity_ref: "Naidu-Group-Pty-Ltd/npc-property-dashbord",
      },
    });
  });

  it("adds nothing when there is no reference", async () => {
    await writeAuditLog({ action: "x", entityType: "y", entityId: null });
    await writeAuditLog({ action: "x", entityType: "y" });
    for (const { row } of h.rows) {
      expect(row).toMatchObject({ entity_id: null, metadata: {} });
    }
  });
});
