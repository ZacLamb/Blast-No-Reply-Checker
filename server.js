// Blast No-Reply Finder
// Scans a GHL sub-account for conversations whose LAST message is an outbound
// SMS, groups them into bursts (a blast = many texts sent close together),
// and tags everyone in the chosen burst. Anyone who replied is automatically
// excluded, because their conversation no longer ends on the blast text.
//
// No database and no env vars required. The GHL token is supplied by the page
// on each request and is never written to disk.

const express = require('express');
const crypto = require('crypto');
const path = require('path');

const PORT = process.env.PORT || 3000;
const GHL_BASE = process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com';
const MAX_RPS = Number(process.env.GHL_MAX_RPS || 8); // GHL allows 100 requests / 10s per location
const CONVERSATIONS_VERSION = process.env.GHL_CONVERSATIONS_VERSION || '2021-04-15';
const CONTACTS_VERSION = process.env.GHL_CONTACTS_VERSION || '2021-07-28';
const KEEP_MS = 2 * 60 * 60 * 1000; // scan results are kept in memory for 2 hours

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- GHL client (rate limited, retries on 429 / 5xx) ----------

let nextSlot = 0;
function throttle() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + 1000 / MAX_RPS;
  return sleep(wait);
}

async function ghl(token, method, pathAndQuery, version, body) {
  for (let attempt = 0; ; attempt++) {
    await throttle();
    let res;
    try {
      res = await fetch(GHL_BASE + pathAndQuery, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Version: version,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if (attempt < 4) { await sleep(1000 * (attempt + 1)); continue; }
      throw new Error(`Could not reach GHL: ${err.message}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(2500 * (attempt + 1));
      continue;
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) {
      const detail = Array.isArray(data.message) ? data.message.join(', ') : (data.message || data.error || text.slice(0, 200));
      let msg = `GHL returned ${res.status}: ${detail}`;
      if (res.status === 401) msg = 'GHL rejected the token (401). Check that the Private Integration token is correct and belongs to this sub-account.';
      if (res.status === 403) msg = `GHL refused access (403): ${detail}. Check the token's scopes and that the Location ID matches the token's sub-account.`;
      const e = new Error(msg);
      e.status = res.status;
      throw e;
    }
    return data;
  }
}

// ---------- Scan ----------

const scans = new Map(); // scanId -> { status, scanned, error, items, createdAt, days }
const tagJobs = new Map(); // jobId -> { status, done, failed, total, tag, error, createdAt }

function tsOf(c) {
  if (Array.isArray(c.sort) && typeof c.sort[0] === 'number') return c.sort[0];
  return Number(c.lastMessageDate) || 0;
}

async function runScan(scan, { token, locationId, days }) {
  const cutoff = Date.now() - days * 86400000;
  const seen = new Set();
  const items = [];
  try {
    for (const type of ['TYPE_SMS', 'TYPE_CAMPAIGN_SMS']) {
      let cursor = null;
      for (;;) {
        const qs = new URLSearchParams({
          locationId,
          limit: '100',
          sort: 'desc',
          sortBy: 'last_message_date',
          lastMessageDirection: 'outbound',
          lastMessageType: type,
        });
        if (cursor !== null) qs.set('startAfterDate', String(cursor));
        const data = await ghl(token, 'GET', `/conversations/search?${qs}`, CONVERSATIONS_VERSION);
        const list = data.conversations || [];
        if (!list.length) break;

        let fresh = 0;
        let oldest = Infinity;
        for (const c of list) {
          const ts = tsOf(c);
          if (ts < oldest) oldest = ts;
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          fresh++;
          if (ts >= cutoff && c.contactId && c.lastMessageDirection !== 'inbound') {
            items.push({
              contactId: c.contactId,
              name: c.fullName || c.contactName || '',
              phone: c.phone || '',
              body: c.lastMessageBody || '',
              ts,
            });
          }
        }
        scan.scanned = items.length;
        if (oldest < cutoff) break;

        // Blast texts often share the same millisecond. Asking for "older than
        // oldest + 1" re-reads any ties instead of skipping them; duplicates
        // are dropped by the `seen` set above.
        if (fresh === 0) {
          if (cursor === oldest) break;
          cursor = oldest;
        } else {
          cursor = oldest + 1;
        }
      }
    }
    items.sort((a, b) => b.ts - a.ts);
    scan.items = items;
    scan.status = 'done';
  } catch (err) {
    scan.status = 'error';
    scan.error = err.message;
  }
}

// A blast = a run of texts where no two neighbours are more than `gapMs` apart,
// containing at least `minSize` contacts.
function findBlasts(items, gapMs, minSize) {
  const blasts = [];
  let cur = [];
  const flush = () => {
    if (cur.length >= minSize) {
      const counts = new Map();
      for (const it of cur) counts.set(it.body, (counts.get(it.body) || 0) + 1);
      let sample = cur[0].body;
      let best = 0;
      for (const [body, n] of counts) if (n > best) { best = n; sample = body; }
      blasts.push({ from: cur[cur.length - 1].ts, to: cur[0].ts, count: cur.length, sample });
    }
    cur = [];
  };
  for (const it of items) {
    if (cur.length && cur[cur.length - 1].ts - it.ts > gapMs) flush();
    cur.push(it);
  }
  flush();
  return blasts;
}

function selectContacts(scan, from, to, contains) {
  const needle = (contains || '').trim().toLowerCase();
  const byContact = new Map();
  for (const it of scan.items) {
    if (it.ts < from || it.ts > to) continue;
    if (needle && !it.body.toLowerCase().includes(needle)) continue;
    if (!byContact.has(it.contactId)) byContact.set(it.contactId, it);
  }
  return [...byContact.values()];
}

// ---------- Tagging ----------

async function runTagJob(job, token, contacts, tag) {
  let index = 0;
  const worker = async () => {
    for (;;) {
      const i = index++;
      if (i >= contacts.length) return;
      try {
        await ghl(token, 'POST', `/contacts/${encodeURIComponent(contacts[i].contactId)}/tags`, CONTACTS_VERSION, { tags: [tag] });
        job.done++;
      } catch (err) {
        job.failed++;
        job.lastError = err.message;
        if (err.status === 401 || err.status === 403) { job.fatal = err.message; index = contacts.length; return; }
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  job.status = job.fatal ? 'error' : 'done';
  if (job.fatal) job.error = job.fatal;
}

// ---------- HTTP ----------

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ ok: true, service: 'blast-no-reply-finder' }));

function creds(req, res) {
  const token = String(req.body?.token || '').trim();
  const locationId = String(req.body?.locationId || '').trim();
  if (!token || !locationId) {
    res.status(400).json({ error: 'Location ID and token are both required.' });
    return null;
  }
  return { token, locationId };
}

function getScan(req, res) {
  const scan = scans.get(req.params.id);
  if (!scan) { res.status(404).json({ error: 'That scan has expired. Run the search again.' }); return null; }
  return scan;
}

function range(q) {
  return { from: Number(q.from), to: Number(q.to), contains: String(q.contains || '') };
}

app.post('/api/scan', (req, res) => {
  const c = creds(req, res);
  if (!c) return;
  const days = Math.min(90, Math.max(1, Number(req.body.days) || 7));
  const id = crypto.randomUUID();
  const scan = { status: 'running', scanned: 0, items: [], createdAt: Date.now(), days };
  scans.set(id, scan);
  runScan(scan, { ...c, days });
  res.json({ scanId: id });
});

app.get('/api/scan/:id', (req, res) => {
  const scan = getScan(req, res);
  if (!scan) return;
  res.json({ status: scan.status, scanned: scan.scanned, error: scan.error || null, days: scan.days });
});

app.get('/api/scan/:id/blasts', (req, res) => {
  const scan = getScan(req, res);
  if (!scan) return;
  if (scan.status !== 'done') return res.status(409).json({ error: 'Scan is not finished yet.' });
  const gapMin = Math.min(240, Math.max(1, Number(req.query.gap) || 10));
  const minSize = Math.min(100000, Math.max(2, Number(req.query.min) || 20));
  res.json({ total: scan.items.length, blasts: findBlasts(scan.items, gapMin * 60000, minSize) });
});

app.get('/api/scan/:id/contacts', (req, res) => {
  const scan = getScan(req, res);
  if (!scan) return;
  const { from, to, contains } = range(req.query);
  const contacts = selectContacts(scan, from, to, contains);
  res.json({ count: contacts.length, preview: contacts.slice(0, 25) });
});

app.get('/api/scan/:id/contacts.csv', (req, res) => {
  const scan = getScan(req, res);
  if (!scan) return;
  const { from, to, contains } = range(req.query);
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const esc = (v) => q(String(v ?? '').replace(/^([=+\-@])/, "'$1")); // stop spreadsheet formulas in free text
  const rows = [['Contact ID', 'Name', 'Phone', 'Blast text sent at (UTC)', 'Last text'].map(esc).join(',')];
  for (const c of selectContacts(scan, from, to, contains)) {
    rows.push([q(c.contactId), esc(c.name), q(c.phone), q(new Date(c.ts).toISOString()), esc(c.body)].join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="no-reply-contacts.csv"');
  res.send(rows.join('\n'));
});

app.post('/api/scan/:id/tag', (req, res) => {
  const scan = getScan(req, res);
  if (!scan) return;
  const c = creds(req, res);
  if (!c) return;
  const tag = String(req.body.tag || '').trim().toLowerCase();
  if (!tag) return res.status(400).json({ error: 'Enter a tag name.' });
  const contacts = selectContacts(scan, Number(req.body.from), Number(req.body.to), req.body.contains);
  if (!contacts.length) return res.status(400).json({ error: 'No contacts match that selection.' });
  const id = crypto.randomUUID();
  const job = { status: 'running', done: 0, failed: 0, total: contacts.length, tag, createdAt: Date.now() };
  tagJobs.set(id, job);
  runTagJob(job, c.token, contacts, tag);
  res.json({ jobId: id, total: contacts.length });
});

app.get('/api/tag/:id', (req, res) => {
  const job = tagJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Tag job not found.' });
  res.json({ status: job.status, done: job.done, failed: job.failed, total: job.total, tag: job.tag, error: job.error || null, lastError: job.lastError || null });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of scans) if (now - s.createdAt > KEEP_MS) scans.delete(id);
  for (const [id, j] of tagJobs) if (now - j.createdAt > KEEP_MS) tagJobs.delete(id);
}, 10 * 60 * 1000).unref();

app.listen(PORT, () => console.log(`blast-no-reply-finder listening on ${PORT}`));
