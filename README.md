# Blast Tools

One page, two tools for a GHL sub-account. Connect with the sub-account's
Location ID and a Private Integration token; nothing is configured in GHL.

**No-reply finder:** find the most recent SMS blast, list everyone who has not
replied to it, and tag them so you can resend from GHL.

**Offer campaign:** the real-offer / estimate text sequence with daily
follow-ups and reply handling, run by this app instead of GHL workflows.

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

No database, no webhooks, no workflow changes, no environment variables. The
token is typed into the page and is never stored on the server.

## Deploy (GitHub + Railway)

1. Create a new GitHub repo and upload these files, keeping `index.html`
   inside a `public` folder.
2. In Railway: New Project -> Deploy from GitHub repo -> pick the repo.
3. Settings -> Networking -> Generate Domain. Open the domain.

## Use

1. In the sub-account: Settings -> Private Integrations -> create a token with
   `conversations.readonly`, `conversations/message.readonly` and
   `contacts.write`.
2. Copy the Location ID from Settings -> Business Profile.
3. Paste both into the page and click **Find recent blasts**.
4. Check the blast it found, then click **Tag contacts**.
5. In GHL: Contacts -> filter Tag is `no-reply-...` -> select all -> send.

## Run automatically (optional)

Step 4 on the page turns on a daily run for that sub-account: at the time you
pick, it finds the latest blast, checks replies and tags the non-responders.
Each blast is tagged once, so a run that finds no new blast does nothing. "Run
now" runs the saved settings immediately. The last ten runs are listed on the
page.

Schedules have to be stored on the server (the token included). Two options:

- **Postgres (recommended on Railway):** add a Postgres database to the project
  and set `DATABASE_URL` on the app to `${{Postgres.DATABASE_URL}}`. The table
  is created automatically.
- **A volume:** mount a Railway volume at `/app/data` (or set `DATA_DIR`). The
  schedules are kept in `schedules.json` there.

With neither, schedules still work but are lost on every redeploy; the page
says so.

Manual use (steps 1-3) needs none of this.

## Offer campaign

Everything is pulled from the sub-account on the "Offer campaign" tab:

- SMS snippets and texts from blasts sent in the last 30 days, to pick the
  three messages from (TEMPLATE 1, THIRD FOLLOW UP, TEMPLATE 2). Merge fields
  such as `{{contact.first_name}}` and `{{contact.offer_k}}` are filled per
  contact by the app, since the API sends text as-is.
- Custom fields (checks `offer_k`, `payback_amount`, `weekly_payment` exist),
  tags, pipelines and stages, users, and the sub-account timezone.

What runs, every 2 minutes while the campaign is on:

1. Contacts newly tagged `sms-real-offer` get TEMPLATE 1; `sms-estimate-offer`
   get THIRD FOLLOW UP. Both then get `sms-followup`. Contacts already on DND or
   tagged `opted-out` are skipped.
2. Replies are picked up (one conversation search, not one call per contact).
   "N" (or any word in the opt-out list): DND for SMS, tag `opted-out`, remove
   `sms-followup`. Anything else: tag `sms-replied`, remove `sms-followup`,
   move the opportunity in the chosen pipeline to the chosen stage, create a
   task for the chosen user; real-offer replies are also assigned to that user
   with a "call within N minutes" task.
3. Anyone still waiting gets TEMPLATE 2 once per day, inside the sending
   window in the contact's timezone (sub-account timezone when the contact has
   none), after a last check that nothing came in. After the cap, they get
   `sms-exhausted` and stop.

"Test with your number" previews or sends any of the three messages to one
existing contact, rendered with that contact's fields.

Token scopes for this tab: `conversations.readonly`,
`conversations/message.readonly`, `conversations/message.write`,
`contacts.readonly`, `contacts.write`, `locations.readonly`,
`locations/templates.readonly`, `locations/customFields.readonly`,
`locations/tags.readonly`, `opportunities.readonly`, `opportunities.write`,
`users.readonly`.

Campaign state (token included) is stored the same way as schedules, so use
Postgres on Railway. GHL has no API for in-app notifications; the task assigned
to the user is the notification. Confirm the sending numbers are A2P 10DLC
registered before turning it on.

## Good to know

- The history check is one GHL request per contact, at about 8 per second, so
  a 4,000-contact blast takes roughly 8 minutes to check.
- If a contact received another automated text after the blast, they belong to
  that later send and will not show under the earlier blast.
- "Only texts containing" narrows the list to texts with a phrase from your
  blast, in case reps were texting other leads during the same minutes.
- Blast dripping out slowly, or under 20 contacts? Open "Not seeing the right
  blast?" and raise the gap or lower the minimum.
- Scan results are held in memory for 2 hours, then discarded.
