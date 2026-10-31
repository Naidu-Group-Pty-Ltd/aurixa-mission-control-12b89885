// Browser stage: render pages that looked JavaScript-built and read the addresses they DISPLAY
// (visible text + mailto links). Pages carrying Cloudflare email protection are skipped (never queued, re-checked here).
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
import { readFileSync, appendFileSync, existsSync } from "node:fs";
const [, , inp, out] = process.argv;
const seen = new Set(existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).url) : []);
const jobs = []; const uniq = new Set();
const perAbn = {};
const isContact = (u) => (/contact|enquir|touch|connect|talk|reach/i.test(u) ? 1 : 0);
const all = readFileSync(inp, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
all.sort((a, b) => isContact(b.url) - isContact(a.url));
for (const j of all) {
  if (uniq.has(j.url)) continue;
  perAbn[j.abn] = (perAbn[j.abn] || 0) + 1;
  if (perAbn[j.abn] > 2 || seen.has(j.url)) continue;
  uniq.add(j.url); jobs.push(j);
}
console.log("to render", jobs.length);
const browser = await chromium.launch();
const UA = "AurixaLeadVerifier/1.0 (business contact verification; reads public contact pages only)";
let i = 0, done = 0, hits = 0; const t0 = Date.now();
async function worker() {
  const ctx = await browser.newContext({ userAgent: UA, javaScriptEnabled: true });
  await ctx.route("**/*", (r) => (["image", "media", "font"].includes(r.request().resourceType()) ? r.abort() : r.continue()));
  while (i < jobs.length) {
    const j = jobs[i++]; let res = { abn: j.abn, url: j.url, emails: [], status: "ok" };
    const page = await ctx.newPage();
    try {
      const resp = await page.goto(j.url, { waitUntil: "domcontentloaded", timeout: 15000 });
      if (!resp || resp.status() !== 200) res.status = "http " + (resp ? resp.status() : "none");
      else {
        await page.waitForLoadState("networkidle", { timeout: 3500 }).catch(() => {});
        const html = await page.content();
        if (/cdn-cgi\/l\/email-protection|data-cfemail|__cf_email__/i.test(html)) res.status = "cf-protected";
        else {
          const text = await page.evaluate(() => document.body ? document.body.innerText : "");
          const mailtos = await page.$$eval("a[href^='mailto:' i]", (as) => as.map((a) => a.getAttribute("href")));
          res.text_emails = [...new Set((text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,24}/g) || []))];
          res.mailtos = [...new Set(mailtos.map((m) => decodeURIComponent(m.replace(/^mailto:/i, "").split("?")[0])))];
          if (res.text_emails.length || res.mailtos.length) hits++;
        }
      }
    } catch (e) { res.status = "error " + String(e).slice(0, 60); }
    await page.close().catch(() => {});
    appendFileSync(out, JSON.stringify(res) + "\n"); done++;
    if (done % 100 === 0) console.log(done, "/", jobs.length, "pages with addresses", hits, Math.round((Date.now() - t0) / 1000) + "s");
  }
  await ctx.close();
}
await Promise.all(Array.from({ length: 24 }, worker));
await browser.close();
console.log("DONE", done, hits);
