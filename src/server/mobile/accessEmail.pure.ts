/**
 * The access email. Composed here, sent by `sendPlatformEmail`.
 *
 * Three rules. **It names the workspace and the app, never the recipient's
 * role or anything about the account** — the email may be forwarded. **It
 * says how long the link lasts and that it works once**, because an expired
 * or spent link is the commonest support question. **Every interpolated value
 * is escaped**: the workspace name is operator-supplied.
 */
import type { TicketKind } from "./tickets.pure";
import { TICKET_LIFETIME_MS } from "./tickets.pure";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

export function lifetimeWords(kind: TicketKind): string {
  const ms = TICKET_LIFETIME_MS[kind];
  return ms >= 3_600_000
    ? `${Math.round(ms / 3_600_000)} hours`
    : `${Math.round(ms / 60_000)} minutes`;
}

export function composeAccessEmail(input: {
  workspaceName: string;
  appLabel: string;
  link: string;
  kind: TicketKind;
}): { subject: string; html: string; text: string } {
  const life = lifetimeWords(input.kind);
  const subject = `Your ${input.appLabel} app for ${input.workspaceName}`;
  const text = [
    `Open this link on the phone you want to use ${input.appLabel} on:`,
    "",
    input.link,
    "",
    `It works once and lasts ${life}. It installs the app if you do not have it yet, then signs you in to ${input.workspaceName}.`,
    "",
    "If you did not ask for this, you can ignore it — nothing happens until the link is opened on a phone.",
    "",
    "Aurixa Systems",
  ].join("\n");
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;line-height:1.5">
<p>Open this link on the phone you want to use <strong>${esc(input.appLabel)}</strong> on:</p>
<p><a href="${esc(input.link)}" style="display:inline-block;padding:12px 20px;background:#0b0b0f;color:#fff;border-radius:8px;text-decoration:none">Open ${esc(input.appLabel)}</a></p>
<p>It works once and lasts ${esc(life)}. It installs the app if you do not have it yet, then signs you in to ${esc(input.workspaceName)}.</p>
<p style="color:#555">If you did not ask for this, you can ignore it — nothing happens until the link is opened on a phone.</p>
<p>Aurixa Systems</p>
</body></html>`;
  return { subject, html, text };
}
