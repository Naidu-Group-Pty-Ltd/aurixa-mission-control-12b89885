# Voice Cloning Studio - runbook

## One-time setup on Mission Control

1. Set `CREDENTIALS_ENC_KEY` if it is not already set. The Studio refuses to store a client key or a fleet secret without it.
2. Set `VOICE_STUDIO_ANTHROPIC_API_KEY`. Never set `ANTHROPIC_API_KEY` for this; see the README.
3. Apply the four `20260924*_voice_studio_*` migrations. The two cron jobs start calling `/hooks/voice-studio-plan` and `/hooks/voice-studio-deploy` every minute.

## Cloning a fleet for a client

1. **Voice → Cloning Studio → New project.** Pick the client, whether a workspace, a lead, an agreement or a prospect.
2. **Documents:** add the brochure, FAQ, price list, policies and booking rules. Each row says whether its text was read, read by the model (PDF), cut short, or unreadable, and why.
3. **Make the plan.** It takes several minutes. The Documents tab shows the stage and the spend so far.
4. **Plan tab:** read the checks, the open items and "What the documents did not answer".
   - Fix what is wrong in an agent edit, or with "Edit everything". Each save is a new version, re-checked.
   - An errored plan cannot be approved.
5. **Approve plan.** This compiles package v1.
6. **Package tab:** read every system prompt and the knowledge base, check the diff against any earlier package, then **Approve package**.
7. **Deploy tab:**
   - Paste the client's VAPI **private** key; it is verified before it is stored.
   - If the fleet transfers to a human, set the Make transfer hook and the escalation number. The Make scenario is the one in `docs/voice-aurixa-pipeline.md`, built in the client's Make account.
   - Set the call log URL and secret for the client workspace's `vapi-call-webhook`, if they have one.
   - **Dry run**, then read the planned steps.
   - **Deploy.** When it finishes, every cell of the verification table must be green.
   - Optional: a VAPI phone number id routes that number to the fleet.
8. Place a test call. Tool calls appear as rows in `voice_tenant_*`, and call logs in the client workspace.

## When something goes wrong

| Symptom                                                         | Where to look                                      | What it means                                                                                                                  |
| --------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Run failed: "spent $X of its cap"                               | Documents tab                                      | Raise `VOICE_STUDIO_MAX_RUN_USD`, or remove documents, and re-plan.                                                            |
| Run failed: "the model declined"                                | Documents tab                                      | A refusal survived the fallbacks. Look for content in the documents the model will not process.                                |
| Run failed: "cut off before it finished"                        | Documents tab                                      | A stage hit its output budget. Split very large documents.                                                                     |
| Run stuck in `running`                                          | `voice_studio_runs.claimed_at`                     | A worker died. The run is re-claimed after its 10-minute lease with its artifacts kept.                                        |
| Deploy failed: "could not parse the knowledge-base file"        | Deploy history                                     | VAPI refused the file; no assistant was pointed at it. Check the KB text on the Package tab for anything unusual and redeploy. |
| Deploy failed: "read-back disagreed on X (system_prompt)"       | Verification table                                 | Someone edited the assistant in VAPI by hand. Deploy again to restore it, or put the change into a plan edit.                  |
| Deploy failed: "nothing to put in {{secret:make_transfer_url}}" | Deploy tab                                         | Set the Make transfer hook.                                                                                                    |
| Tool calls answer 401                                           | `audit_log` action `voice_tenant_webhook_rejected` | The secret VAPI sent does not match the tenant's. Redeploy to rewrite it.                                                      |
| Tool calls answer 403 `tenant_disabled`                         | `voice_tenant_configs.enabled`                     | No apply has verified yet.                                                                                                     |
| Booking tool says "online booking is not set up"                | Plan profile's booking window                      | The documents did not establish one. Add it in a plan edit.                                                                    |

## Rolling back

Deploy tab → **Roll back to** a package that deployed successfully before. It
re-applies that package through the same engine. Nothing is deleted: the
knowledge-base files of every version stay in the client's org.

## Rotating secrets

- **Client VAPI key:** paste the new one on the Deploy tab. The next deploy uses it.
- **Make hook, call log secret:** set on the Deploy tab, then **Deploy**. The ledger sees the changed payload hash and rewrites only what carries it.
- **The tenant webhook secret** is minted once per project and is not rotated from the UI, because rotating it would break a live fleet between the database write and the deploy.
