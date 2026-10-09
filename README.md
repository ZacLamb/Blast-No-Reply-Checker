# Blast No-Reply Finder

One page, one job: find the most recent SMS blast in a GHL sub-account, list
everyone who has not replied to it, and tag them so you can resend from GHL.

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
