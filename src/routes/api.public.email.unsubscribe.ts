import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  campaignForLink,
  readLinkToken,
  suppressAddress,
  unsubscribeThroughCampaign,
} from "@/server/email-unsubscribe.server";

/**
 * GET/POST /api/public/email/unsubscribe?t=<token>
 * GET/POST /api/public/email/unsubscribe?c=<campaign token>
 *
 * The unsubscribe facility every campaign message can carry. Unauthenticated
 * by necessity — the person clicking it has no account here — so the token IS
 * the authorisation: 64 hex characters minted per recipient, unique-indexed,
 * and good for exactly one address.
 *
 * A message to several contacts carries the campaign's shared token instead
 * (`?c=`): the reader types the address the message reached them at, it is
 * removed only if the campaign has it, and the page answers the same either
 * way. See `email-unsubscribe.server.ts`.
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

/** A token from the form, else from the query string, under one parameter name. */
function readToken(request: Request, name: "t" | "c", formValue?: string | null): string | null {
  return readLinkToken(formValue) ?? readLinkToken(new URL(request.url).searchParams.get(name));
}

/** The form behind a campaign's shared link: the reader names their own address. */
function sharedForm(campaignToken: string, problem: string | null = null, typed = ""): string {
  return `<h1>Unsubscribe</h1>
    <p>Enter the email address this message was sent to, and it will stop receiving email from us.</p>
    ${problem ? `<p><strong>${escapeHtml(problem)}</strong></p>` : ""}
    <form method="post">
      <input type="hidden" name="c" value="${escapeHtml(campaignToken)}">
      <p><input type="email" name="email" required autocomplete="email" value="${escapeHtml(typed)}"
        placeholder="you@example.com" aria-label="Email address"
        style="font:inherit;width:100%;padding:10px 12px;border:1px solid var(--line);background:var(--panel);color:var(--ink)"></p>
      <button type="submit">Unsubscribe this address</button>
    </form>
    <p class="note">This applies to every campaign, not just the message you received.</p>`;
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
        const campaignToken = readToken(request, "c");
        if (campaignToken) {
          if (!(await campaignForLink(campaignToken))) {
            return page("Unsubscribe", NOT_A_LINK, 404);
          }
          return page("Unsubscribe", sharedForm(campaignToken));
        }

        const token = readToken(request, "t");
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
        let form: FormData | null = null;
        try {
          form = await request.formData();
        } catch {
          // A JSON or empty body is fine; the query string still carries it.
        }

        const campaignToken = readToken(request, "c", String(form?.get("c") ?? ""));
        if (campaignToken) {
          const campaign = await campaignForLink(campaignToken);
          if (!campaign) return page("Unsubscribe", NOT_A_LINK, 404);
          const typed = String(form?.get("email") ?? "").slice(0, 320);
          const outcome = await unsubscribeThroughCampaign(campaign.id, typed);
          if (outcome.kind === "invalid_address") {
            return page(
              "Unsubscribe",
              sharedForm(campaignToken, "That does not look like an email address.", typed),
              400,
            );
          }
          if (outcome.kind === "failed") return page("Unsubscribe", WRITE_FAILED, 500);
          return page("Unsubscribed", sharedDone(outcome.address));
        }

        const token = readToken(request, "t", String(form?.get("t") ?? ""));
        if (!token) return page("Unsubscribe", NOT_A_LINK, 400);

        const recipient = await findRecipient(token);
        if (!recipient) return page("Unsubscribe", NOT_A_LINK, 404);

        if (!(await suppressAddress(recipient, "requested through the unsubscribe link"))) {
          return page("Unsubscribe", WRITE_FAILED, 500);
        }
        return page("Unsubscribed", alreadyDone(recipient.email));
      },
    },
  },
});

const WRITE_FAILED = `<h1>Something went wrong</h1>
  <p>We could not record your request just now. Please try again in a few minutes, or reply to the message you received and we will do it by hand.</p>`;

/**
 * The same words whether or not the campaign had the address, so the page
 * cannot be used to learn who is on a list.
 */
function sharedDone(address: string): string {
  return `<h1>Unsubscribed</h1>
    <p>If <strong>${escapeHtml(address)}</strong> received this email from us, it has been removed and will not receive any further campaign email.</p>
    <p class="note">Still hearing from us at another address? Unsubscribe that one too, or reply to the message and we will remove you by hand.</p>`;
}

const NOT_A_LINK = `<h1>This link is no longer valid</h1>
  <p>It may have expired, or the address may already have been removed. If you are still receiving email you did not ask for, reply to the message and we will remove you by hand.</p>`;

function alreadyDone(email: string): string {
  return `<h1>Unsubscribed</h1>
    <p><strong>${escapeHtml(email)}</strong> has been removed. You will not receive any further campaign email from us.</p>
    <p class="note">You can close this window.</p>`;
}
