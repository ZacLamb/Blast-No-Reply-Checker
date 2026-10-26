# Blast Follow-Up

Find the most recent SMS blast in a GoHighLevel sub-account, check every contact's reply
history, and tag the non-responders so you can resend from GHL. Optionally runs daily.

Runs on the RGS Tools Hub: login, billing and GHL credentials come from the hub. The user
picks a connected sub-account; the server fetches its token from the hub per request, and
again at run time for schedules. No token is typed into or stored by this app.

- `/` landing page, `/app` the tool
- Scans and jobs are owned by the hub user; schedules are keyed by user + sub-account
- The scheduler only runs a schedule whose user is still entitled (or admin) and still has
  that sub-account connected
- `campaign.js` (the offer-text campaign) is parked and not mounted — it predates the hub
  and took a raw token in the body. Bring it onto hub credentials before re-enabling.

## How it works

1. It asks GHL for every conversation whose **last message is an outbound SMS**.
2. It groups those by send time. A run of texts sent close together is a blast.
3. You pick the blast. It then reads each contact's message history and drops
   anyone who has sent anything inbound (text, call, email or chat).
4. It adds one tag to everyone who is left.

So a contact who got the blast, replied, and then got an answer from a rep is
never tagged, even though their conversation ends on an outbound text.

"Leave out" controls how strict the check is:

- **Anyone who has ever replied** (default): only contacts with no inbound
  message in their whole history are tagged.
- **Only people who replied since this blast**: contacts who answered some
  older message, but not this blast, are tagged too.

No webhooks and no workflow changes.

## Unanswered replies

The **Unanswered replies** tab lists every contact whose conversation ends on *their*
message: they texted (or, with "all channels", called, emailed or chatted) and nobody in
the sub-account has answered since. Longest wait first, with a link to each conversation,
a CSV export and an optional tag (`needs-reply-YYYY-MM-DD`) so you can filter them in GHL.
Replies that are just an opt-out word (STOP, unsubscribe…) are left out. "Waiting at least"
skips replies that only just came in.

## Deploy (Railway)

Env vars: `HUB_URL`, `HUB_JWT_SECRET`, `HUB_SERVICE_KEY` (same values as the hub). Optional:
`DATABASE_URL` (Postgres for schedules; otherwise a JSON file in `DATA_DIR`, which Railway
wipes on redeploy), `GHL_BASE_URL`, `GHL_MAX_RPS`.

Custom domain must be a subdomain of the hub's `COOKIE_DOMAIN` (e.g. `blast.yourbizzassist.co`),
and the hub needs `TOOL_URL_BLAST_TOOLS=https://blast.yourbizzassist.co`.

Scopes used (already on the hub's marketplace app): `conversations.readonly`,
`conversations/message.readonly`, `contacts.write`, and `conversations/message.write` (only for replying from the Unanswered replies tab).

## Use

1. Pick the sub-account and click **Find recent blasts**.
2. Check the blast it found, then click **Tag contacts**.
3. In GHL: Contacts -> filter Tag is `no-reply-...` -> select all -> send.

## Run automatically (optional)

Step 4 on the page turns on a daily run for that sub-account: at the time you
pick, it finds the latest blast, checks replies and tags the non-responders.
Each blast is tagged once, so a run that finds no new blast does nothing. "Run
now" runs the saved settings immediately. The last ten runs are listed on the
page.

Schedules live in Postgres when `DATABASE_URL` is set, otherwise in a JSON file.

## API usage reporting

Blast Follow-Up reports how much of RGS Tools' GHL API allowance it uses per sub-account, shown on
Backup & Insights › Usage › RGS Tools API usage. `ghl()` in `server.js` reads HighLevel's rate-limit headers
(`X-RateLimit-Daily-Remaining`, `X-RateLimit-Remaining`, …) on every response, counts calls per sub-account,
and sends a batch to the hub (`POST /internal/api-usage`) every 60 s and on shutdown. It is fire-and-forget:
a slow or unreachable hub never slows or fails a request, and tokens are never logged or sent.
`ghl-usage.js` is a copy of the hub's `hub-client/ghl-usage.js`; keep them in sync.

Uses the existing `HUB_URL` + `HUB_SERVICE_KEY`. Optional:

| Var | Default | |
|---|---|---|
| `API_USAGE_REPORTING` | on | `off` stops reporting |
| `API_USAGE_FLUSH_MS` | `60000` | how often counts are sent to the hub |
