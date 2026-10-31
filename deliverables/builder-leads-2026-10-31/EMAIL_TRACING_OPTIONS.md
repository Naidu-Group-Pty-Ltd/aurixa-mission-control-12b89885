# Getting emails for the rest of the leads

The in-house scraper (`pipeline/core`, run with `pipeline/run_scraper.sh`) has now been through every free, legitimate source it can reach:

- the businesses' own websites (homepage, contact/about/team pages, sitemaps, structured data, JavaScript-rendered pages and capability PDFs);
- the Master Builders directories that allow it;
- about 1 million guessed domains, checked over DNS;
- the full Common Crawl list of `.au` domains, plus `.com` domains containing building words;
- three rounds of web search for the largest companies.

Each extra pass now adds only dozens of addresses. Taking coverage much further needs one of the options below.

## Where the gap is

| Group                                        | Leads   | What can close it                                                                   |
| -------------------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| No findable website (organisations)          | 17,282  | Option 1: find each company's website from Google Places, then run the scraper on it. |
| Website found, but only a contact form       | ~2,330  | Option 2: Hunter.io (addresses published elsewhere on the web), or option 5.         |
| Website hides its email (Cloudflare protection) | 685 | Option 5 (phone/form outreach). Don't decode these.                                 |
| Sole traders with no web presence            | ~6,400  | Options 5 and 6.                                                                     |
| Every campaign address (before sending)      | 8,034   | Option 3: mailbox verification.                                                      |

## Options, best value first

### 1. Google Places API (connector built: `pipeline/connectors/places_websites.py`)

Most small builders keep a Google Business Profile, and its "website" field is the missing link. The connector:

1. runs one Text Search per lead (name, "builder", state);
2. accepts the result only when the name matches at 80 or more and the address is in the lead's state;
3. hands the website to the scraper, which reads the email from the builder's own site and validates it as usual.

- **Run:** `GOOGLE_PLACES_API_KEY=... bash pipeline/run_scraper.sh`. Without a key it is a dry run that shows the queries.
- **Expected:** if a third of the ~17,000 have a listed website and about 60% of those publish an email, roughly **2,000–3,500 more valid addresses**.
- **Cost:** about 17,000 Text Search requests on the field mask that includes `websiteUri` (the Enterprise SKU). Check current Google Maps Platform pricing and free monthly usage before a full run, and try `--limit 500` first.
- **Terms:** Google Maps Platform terms restrict storing Places content. The connector keeps only the website URL needed to visit the business's own site.

### 2. Hunter.io Domain Search (connector built: `pipeline/connectors/hunter_domains.py`)

This is for the ~2,300 contact-form-only websites. Hunter returns the addresses it has seen published for a domain, with the source pages. The connector keeps generic inboxes, plus personal addresses at 90% confidence or higher.

- **Run:** `HUNTER_API_KEY=... bash pipeline/run_scraper.sh`
- **Expected:** typically 30–50% of domains return a usable address, so roughly **700–1,100 more**.
- **Cost:** one request per domain, which needs a paid plan with about 2,500 searches.

### 3. Mailbox verification: ZeroBounce or NeverBounce (connector built: `pipeline/connectors/verify_mailboxes.py`)

These services check each mailbox against its mail server. That is the one check this environment can't do, because outbound SMTP is blocked here.

- **Results:**
  - `valid`: confirmed.
  - `catch-all` or `unknown`: moved to Risky.
  - `invalid`, `spamtrap` or `do_not_mail`: dropped automatically.
- **Run:** `ZEROBOUNCE_API_KEY=...` (or `NEVERBOUNCE_API_KEY=...`) `bash pipeline/run_scraper.sh`
- **Cost:** about 8,000 checks at well under a cent each. Strongly recommended before the first send, because bounces count against the Microsoft 365 sending reputation.

### 4. Licensed B2B contact databases (Apollo.io, ZoomInfo, Lusha, Cognism, illion business data)

Upload the ABN-validated organisation list (Company, Website, State) for enrichment. These databases often hold named decision-maker emails (owner, director, estimator) for Medium and larger builders, which websites rarely publish.

- **Coverage:** best for the ~6,000 Medium/Large/Enterprise leads.
- **Licence and compliance:** check each provider's data licence and how it collected the data. The Spam Act consent rules still apply to every message you send.

### 5. Phone-first capture (best for compliance)

2,423 leads with no email have a phone number. A short call or SMS ("Who should receive builder-partner information?") gives you an address with **express consent**, which is better than inferred consent. Mission Control's voice and SMS stack can run this.

### 6. Reach members through the associations

- Master Builders and HIA offer sponsorship, newsletter advertising and event partnerships, which reach members who keep their addresses private.
- UDIA, The Urban Developer events and the HIA Home Shows do the same for developers.
- A builder-partner sign-up page promoted through these channels collects consented contacts straight into Mission Control.

## What not to do

- **Don't guess addresses** such as info@<domain> without a mailbox check. Guessed addresses aren't "conspicuously published", so the Spam Act's inferred consent doesn't cover them. They also bounce at high rates.
- **Don't decode Cloudflare-hidden or "[at]"-obfuscated addresses.** The owner has opted out of automated collection.
- **Don't scrape** Google Search/Maps pages, LinkedIn, Facebook, or directories whose terms or robots.txt forbid it (Yellow Pages, hipages, Oneflare and similar). Use their official APIs or partner programs instead.

## Spam Act 2003 reminder

These addresses were collected automatically, so this is a harvested-address list. Send only messages that meet inferred consent from conspicuous publication:

- the message relates to the recipient's building or development business;
- no "unsolicited email not wanted" statement accompanies the address (checked automatically);
- you identify yourself as the sender;
- every message includes `{{unsubscribe_url}}`, and unsubscribes are honoured within 5 business days.

If in doubt, get legal advice before the first send.
