-- @asserts column:live_audit_settings.claude_enabled
--
-- The live audit runs on Claude only when a person turns it on.
--
-- Mission Control already holds an org-scoped ANTHROPIC_API_KEY, for Codex
-- Security's critical and high fixes, and its nightly secret sync writes that
-- key into Prime's Actions secrets (github_secret_syncs, every night). The
-- live audit is to run on the workspace-scoped key the owner provisions when
-- they choose, so a key being present is not consent to spend it: as first
-- shipped, a run started from the page would have read code, explored and
-- judged on the org key, and "Fix with Claude" would have drafted on it.
--
-- Until claude_enabled is set, every run is dispatched with Claude off (the
-- runner makes no Anthropic call; it crawls and judges from the browser alone)
-- and no fix is drafted, by a person or automatically. Off for the row that
-- exists and for any row created later.
ALTER TABLE public.live_audit_settings
  ADD COLUMN IF NOT EXISTS claude_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.live_audit_settings.claude_enabled IS
  'Claude reads the code, explores, judges and drafts fixes only when true. Off until the owner provisions the live audit''s Anthropic key and turns it on.';
