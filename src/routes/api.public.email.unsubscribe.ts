import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * GET/POST /api/public/email/unsubscribe?t=<token>
 *
 * The unsubscribe facility every campaign message can carry. Unauthenticated
 * by necessity — the person clicking it has no account here — so the token IS
 * the authorisation: 64 hex characters minted per recipient, unique-indexed,
 * and good for exactly one address.
 *
 * ## Why a GET does not unsubscribe anybody
 *
 * A link in an email is fetched by things that are not the recipient. Outlook
 * Safe Links, corporate mail gateways, spam scanners and preview panes all
 * follow URLs in a message before a human has seen it, and an endpoint that
 * acts on GET therefore unsubscribes people who never clicked — silently, and
 * in a way that looks from every log like they chose to. So GET renders a page
 * with a button, and the POST behind that button is what writes anything. The
 * cost is one extra click; the alternative is losing recipients to a scanner.
 *
 * ## What it writes
 *
 * A row in the register, which is global: unsubscribing from one campaign
 * stops every campaign, now and later. That is the correct reading of what
 * somebody means by the word, and it is the same table the bounce scanner
 * writes to, so there is exactly one list of addresses this deployment will
 * not mail.
 */

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" } as const;

function escapeHtml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --ink:#111318; --muted:#5b6070; --line:#d9dce4; --bg:#f6f7f9; --panel:#ffffff; }
  @media (prefers-color-scheme: dark) {
    :root { --ink:#eef0f4; --muted:#9aa0b0; --line:#2a2e39; --bg:#0d0f13; --panel:#14171d; }
  }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:var(--bg); color:var(--ink); padding:24px;
         font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  main { background:var(--panel); border:1px solid var(--line); max-width:34rem; width:100%; padding:32px; }
  h1 { font-size:1.35rem; margin:0 0 12px; letter-spacing:-0.01em; }
  p { margin:0 0 16px; color:var(--muted); }
  strong { color:var(--ink); }
  button { font:inherit; font-weight:600; padding:12px 20px; border:1px solid var(--ink);
           background:var(--ink); color:var(--panel); cursor:pointer; }
  button:hover { opacity:.9; }
  .note { font-size:.85rem; margin-top:20px; }
</style>
</head><body><main>${body}</main></body></html>`,
    { status, headers: HTML_HEADERS },
  );
}

const TOKEN_SHAPE = /^[a-f0-9]{16,128}$/i;

function readToken(request: Request, formValue?: string | null): string | null {
  const fromForm = (formValue ?? "").trim();
  if (fromForm && TOKEN_SHAPE.test(fromForm)) return fromForm.toLowerCase();
  const url = new URL(request.url);
  const raw = (url.searchParams.get("t") ?? "").trim();
  return raw && TOKEN_SHAPE.test(raw) ? raw.toLowerCase() : null;
}

type Recipient = {
  id: string;
  email: string;
  email_key: string;
  campaign_id: string;
  status: string;
};

async function findRecipient(token: string): Promise<Recipient | null> {
  const { data, error } = await supabaseAdmin
    .from("email_campaign_recipients")
    .select("id, email, email_key, campaign_id, status")
    .eq("unsubscribe_token", token)
    .maybeSingle();
  if (error) {
    console.error("[email] unsubscribe lookup failed:", error.message);
    return null;
  }
  return (data as Recipient | null) ?? null;
}

export const Route = createFileRoute("/api/public/email/unsubscribe")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const token = readToken(request);
        if (!token) return page("Unsubscribe", NOT_A_LINK, 400);

        const recipient = await findRecipient(token);
        if (!recipient) return page("Unsubscribe", NOT_A_LINK, 404);

        const { data: existing } = await supabaseAdmin
          .from("email_suppressions")
          .select("email_key")
          .eq("email_key", recipient.email_key)
          .maybeSingle();
        if (existing) return page("Already unsubscribed", alreadyDone(recipient.email));

        return page(
          "Unsubscribe",
          `<h1>Unsubscribe</h1>
           <p>Confirm that <strong>${escapeHtml(recipient.email)}</strong> should stop receiving email from us.</p>
           <form method="post">
             <input type="hidden" name="t" value="${escapeHtml(token)}">
             <button type="submit">Unsubscribe this address</button>
           </form>
           <p class="note">This applies to every campaign, not just the message you received.</p>`,
        );
      },

      POST: async ({ request }) => {
        let formToken: string | null = null;
        try {
          const form = await request.formData();
          formToken = String(form.get("t") ?? "");
        } catch {
          // A JSON or empty body is fine; the query string still carries it.
        }
        const token = readToken(request, formToken);
        if (!token) return page("Unsubscribe", NOT_A_LINK, 400);

        const recipient = await findRecipient(token);
        if (!recipient) return page("Unsubscribe", NOT_A_LINK, 404);

        const now = new Date().toISOString();
        const { error } = await supabaseAdmin.from("email_suppressions").upsert(
          {
            email_key: recipient.email_key,
            email: recipient.email,
            reason: "unsubscribed",
            detail: "requested through the unsubscribe link",
            source: "unsubscribe_link",
            campaign_id: recipient.campaign_id,
            last_seen_at: now,
          },
          { onConflict: "email_key" },
        );
        if (error) {
          console.error("[email] unsubscribe write failed:", error.message);
          return page(
            "Unsubscribe",
            `<h1>Something went wrong</h1>
             <p>We could not record your request just now. Please try again in a few minutes, or reply to the message you received and we will do it by hand.</p>`,
            500,
          );
        }

        // Every campaign, immediately — including ones this person has not
        // been mailed by yet.
        const { error: stopError } = await supabaseAdmin
          .from("email_campaign_recipients")
          .update({ status: "suppressed", suppressed_reason: "unsubscribed" })
          .eq("email_key", recipient.email_key)
          .eq("status", "pending");
        if (stopError) {
          console.error(
            "[email] could not stop pending sends after unsubscribe:",
            stopError.message,
          );
        }

        return page("Unsubscribed", alreadyDone(recipient.email));
      },
    },
  },
});

const NOT_A_LINK = `<h1>This link is no longer valid</h1>
  <p>It may have expired, or the address may already have been removed. If you are still receiving email you did not ask for, reply to the message and we will remove you by hand.</p>`;

function alreadyDone(email: string): string {
  return `<h1>Unsubscribed</h1>
    <p><strong>${escapeHtml(email)}</strong> has been removed. You will not receive any further campaign email from us.</p>
    <p class="note">You can close this window.</p>`;
}
