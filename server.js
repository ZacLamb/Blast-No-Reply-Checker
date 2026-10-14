// Blast No-Reply Finder
// Scans a GHL sub-account for conversations whose LAST message is an outbound
// SMS, groups them into bursts (a blast = many texts sent close together),
// reads each contact's message history to drop anyone who has replied, and
// tags the rest.
//
// Manual use needs no database and no env vars: the token is typed into the
// page and only lives in memory. The optional "run automatically" schedule has
// to keep the token and the settings somewhere, so it uses Postgres when
// DATABASE_URL is set, and otherwise a JSON file in DATA_DIR (./data).

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const GHL_BASE = process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com';
const MAX_RPS = Number(process.env.GHL_MAX_RPS || 8); // GHL allows 100 requests / 10s per location
const CONVERSATIONS_VERSION = process.env.GHL_CONVERSATIONS_VERSION || '2021-04-15';
const CONTACTS_VERSION = process.env.GHL_CONTACTS_VERSION || '2021-07-28';
const KEEP_MS = 2 * 60 * 60 * 1000; // scan results are kept in memory for 2 hours
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TICK_MS = Number(process.env.SCHEDULE_TICK_MS || 60000);

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
      const d = String(detail).replace(/\.+$/, '');
      let msg = `GHL returned ${res.status}: ${d}`;
      if (res.status === 401) msg = `GHL rejected the token (401): ${d}. Check that the Private Integration token is correct, belongs to this sub-account, and has all three scopes: conversations.readonly, conversations/message.readonly, contacts.write.`;
      if (res.status === 403) msg = `GHL refused access (403): ${d}. Check the token's scopes and that the Location ID matches the token's sub-account.`;
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
              conversationId: c.id,
              contactId: c.contactId,
              checked: false,    // has the message history been read yet?
              lastInbound: null, // time of the contact's most recent inbound message, if any
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

// ---------- Reply check ----------
// The search above only knows about the LAST message. To be sure a contact
// never answered, read their message history and look for anything inbound
// (text, call, email, chat). System activity entries are ignored.

const verifyJobs = new Map(); // jobId -> { status, done, failed, total, error, createdAt }

async function findLastInbound(token, conversationId) {
  let lastMessageId = null;
  for (let page = 0; page < 40; page++) {
    const qs = new URLSearchParams({ limit: '100' });
    if (lastMessageId) qs.set('lastMessageId', lastMessageId);
    const data = await ghl(token, 'GET', `/conversations/${encodeURIComponent(conversationId)}/messages?${qs}`, CONVERSATIONS_VERSION);
    const box = data.messages || {};
    const list = box.messages || [];
    for (const m of list) { // newest first
      const type = String(m.messageType || '');
      if (m.direction === 'inbound' && !type.startsWith('TYPE_ACTIVITY') && type !== 'TYPE_INTERNAL_COMMENTS') {
        return Date.parse(m.dateAdded) || Date.now();
      }
    }
    if (!box.nextPage || !list.length || !box.lastMessageId || box.lastMessageId === lastMessageId) break;
    lastMessageId = box.lastMessageId;
  }
  return null;
}

async function runVerifyJob(job, token, items) {
  let index = 0;
  const worker = async () => {
    for (;;) {
      const i = index++;
      if (i >= items.length) return;
      const it = items[i];
      try {
        if (!it.checked) {
          it.lastInbound = await findLastInbound(token, it.conversationId);
          it.checked = true;
        }
        job.done++;
      } catch (err) {
        job.failed++;
        job.lastError = err.message;
        if (err.status === 401 || err.status === 403) { job.fatal = err.message; index = items.length; return; }
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  job.status = job.fatal ? 'error' : 'done';
  if (job.fatal) job.error = job.fatal;
}

// mode 'ever'  -> leave out anyone who has EVER sent anything inbound (default)
// mode 'since' -> leave out only people who replied after this blast started
function selectContacts(scan, from, to, contains, mode) {
  const needle = (contains || '').trim().toLowerCase();
  const byContact = new Map();
  let inRange = 0, replied = 0, unchecked = 0;
  for (const it of scan.items) {
    if (it.ts < from || it.ts > to) continue;
    if (needle && !it.body.toLowerCase().includes(needle)) continue;
    inRange++;
    if (!it.checked) { unchecked++; continue; }
    const hasReplied = mode === 'since' ? (it.lastInbound !== null && it.lastInbound >= from) : it.lastInbound !== null;
    if (hasReplied) { replied++; continue; }
    if (!byContact.has(it.contactId)) byContact.set(it.contactId, it);
  }
  return { contacts: [...byContact.values()], inRange, replied, unchecked };
}

async function verifyAll(token, items) {
  const job = { status: 'running', done: 0, failed: 0, total: items.length };
  await runVerifyJob(job, token, items);
  if (job.fatal) throw new Error(job.fatal);
  return job;
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

// ---------- Schedule storage ----------
// One schedule per sub-account. Postgres if DATABASE_URL is set, else a JSON file.

let store;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined });
  store = {
    kind: 'postgres',
    async init() {
      await pool.query('CREATE TABLE IF NOT EXISTS schedules (location_id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    },
    async all() { return (await pool.query('SELECT data FROM schedules')).rows.map((r) => r.data); },
    async get(locationId) { const r = await pool.query('SELECT data FROM schedules WHERE location_id = $1', [locationId]); return r.rows[0]?.data || null; },
    async put(sched) { await pool.query('INSERT INTO schedules (location_id, data, updated_at) VALUES ($1, $2, now()) ON CONFLICT (location_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()', [sched.locationId, sched]); },
    async remove(locationId) { await pool.query('DELETE FROM schedules WHERE location_id = $1', [locationId]); },
  };
} else {
  const file = path.join(DATA_DIR, 'schedules.json');
  let cache = null;
  const load = () => { if (cache) return cache; try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { cache = {}; } return cache; };
  const save = () => { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(cache, null, 2)); fs.renameSync(tmp, file); };
  store = {
    kind: 'file',
    async init() { load(); },
    async all() { return Object.values(load()); },
    async get(locationId) { return load()[locationId] || null; },
    async put(sched) { load()[sched.locationId] = sched; save(); },
    async remove(locationId) { delete load()[locationId]; save(); },
  };
}

// ---------- Scheduler ----------

function zoneOk(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }

// Local wall clock for a zone: { date: 'YYYY-MM-DD', hm: 'HH:MM', dow: 0-6 }
function localClock(tz, at = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' })
    .formatToParts(at).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hm: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`, dow };
}

function tagFor(ts, tz) {
  const d = new Date(ts);
  const mon = d.toLocaleDateString('en-US', { timeZone: tz, month: 'short' }).toLowerCase();
  const day = Number(d.toLocaleDateString('en-US', { timeZone: tz, day: 'numeric' }));
  return `no-reply-${mon}-${day}`;
}

function publicSchedule(s) {
  if (!s) return null;
  const { token, ...rest } = s;
  return { ...rest, tokenHint: token ? '…' + token.slice(-4) : null };
}

const running = new Set();

// The whole flow, unattended: latest blast -> reply check -> tag.
async function runSchedule(sched, { force = false } = {}) {
  if (running.has(sched.locationId)) return { skipped: 'already running' };
  running.add(sched.locationId);
  const started = Date.now();
  const result = { at: started, ok: false };
  try {
    const scan = { status: 'running', scanned: 0, items: [] };
    await runScan(scan, { token: sched.token, locationId: sched.locationId, days: sched.lookbackDays });
    if (scan.status === 'error') throw new Error(scan.error);
    const blasts = findBlasts(scan.items, sched.gapMin * 60000, sched.minSize);
    if (!blasts.length) { Object.assign(result, { ok: true, outcome: 'no-blast', message: `No blast found in the last ${sched.lookbackDays} days.` }); return result; }
    const b = blasts[0];
    const key = `${b.from}-${b.to}`;
    result.blast = { from: b.from, to: b.to, count: b.count, sample: b.sample };
    if (!force && sched.lastBlastKey === key) {
      Object.assign(result, { ok: true, outcome: 'already-done', message: 'The latest blast was already tagged on an earlier run; nothing new to do.' });
      return result;
    }
    const inBlast = scan.items.filter((it) => it.ts >= b.from && it.ts <= b.to);
    const v = await verifyAll(sched.token, inBlast);
    const sel = selectContacts(scan, b.from, b.to, '', sched.mode);
    const tag = tagFor(b.to, sched.timezone);
    const job = { status: 'running', done: 0, failed: 0, total: sel.contacts.length, tag };
    if (sel.contacts.length) await runTagJob(job, sched.token, sel.contacts, tag);
    if (job.fatal) throw new Error(job.fatal);
    sched.lastBlastKey = key;
    Object.assign(result, {
      ok: true, outcome: 'tagged', tag, tagged: job.done, tagFailed: job.failed, replied: sel.replied,
      unchecked: sel.unchecked + v.failed, inBlast: inBlast.length,
      message: `Tagged ${job.done} contacts "${tag}". ${sel.replied} left out because they replied.` + (job.failed || v.failed ? ` ${job.failed + v.failed} could not be processed.` : ''),
    });
    return result;
  } catch (err) {
    Object.assign(result, { ok: false, outcome: 'error', message: err.message });
    return result;
  } finally {
    result.ms = Date.now() - started;
    sched.lastRun = result;
    sched.history = [result, ...(sched.history || [])].slice(0, 10);
    try { await store.put(sched); } catch (e) { console.error('could not save schedule result', e.message); }
    running.delete(sched.locationId);
  }
}

function isDue(sched, now = new Date()) {
  if (!sched.enabled) return false;
  const c = localClock(sched.timezone, now);
  if (sched.days === 'weekdays' && (c.dow === 0 || c.dow === 6)) return false;
  if (sched.lastRunDate === c.date) return false;
  return c.hm >= sched.time;
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    for (const sched of await store.all()) {
      if (String(sched.locationId || '').startsWith('campaign:')) continue;
      if (!isDue(sched)) continue;
      sched.lastRunDate = localClock(sched.timezone).date;
      await store.put(sched);
      console.log(`[schedule] running ${sched.locationId}`);
      const r = await runSchedule(sched);
      console.log(`[schedule] ${sched.locationId}: ${r.outcome || r.skipped} - ${r.message || ''}`);
    }
  } catch (err) {
    console.error('[schedule] tick failed', err.message);
  } finally {
    ticking = false;
  }
}

// ---------- HTTP ----------

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ ok: true, service: 'blast-no-reply-finder' }));

const campaign = require('./campaign')({ ghl, store, findLastInbound, localClock, runScan, findBlasts, CONVERSATIONS_VERSION, CONTACTS_VERSION });
app.use('/api/campaign', campaign.router);

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
  return { from: Number(q.from), to: Number(q.to), contains: String(q.contains || ''), mode: q.mode === 'since' ? 'since' : 'ever' };
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
  const { from, to, contains, mode } = range(req.query);
  const r = selectContacts(scan, from, to, contains, mode);
  const slim = (c) => ({ name: c.name, phone: c.phone, ts: c.ts, body: c.body });
  res.json({ count: r.contacts.length, inRange: r.inRange, replied: r.replied, unchecked: r.unchecked, preview: r.contacts.slice(0, 25).map(slim) });
});

app.get('/api/scan/:id/contacts.csv', (req, res) => {
  const scan = getScan(req, res);
  if (!scan) return;
  const { from, to, contains, mode } = range(req.query);
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const esc = (v) => q(String(v ?? '').replace(/^([=+\-@])/, "'$1")); // stop spreadsheet formulas in free text
  const rows = [['Contact ID', 'Name', 'Phone', 'Blast text sent at (UTC)', 'Last text'].map(esc).join(',')];
  for (const c of selectContacts(scan, from, to, contains, mode).contacts) {
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
  const { from, to, contains, mode } = range(req.body);
  const { contacts } = selectContacts(scan, from, to, contains, mode);
  if (!contacts.length) return res.status(400).json({ error: 'No contacts match that selection.' });
  const id = crypto.randomUUID();
  const job = { status: 'running', done: 0, failed: 0, total: contacts.length, tag, createdAt: Date.now() };
  tagJobs.set(id, job);
  runTagJob(job, c.token, contacts, tag);
  res.json({ jobId: id, total: contacts.length });
});

app.post('/api/scan/:id/verify', (req, res) => {
  const scan = getScan(req, res);
  if (!scan) return;
  const c = creds(req, res);
  if (!c) return;
  const from = Number(req.body.from), to = Number(req.body.to);
  const items = scan.items.filter((it) => it.ts >= from && it.ts <= to && !it.checked);
  const id = crypto.randomUUID();
  const job = { status: items.length ? 'running' : 'done', done: 0, failed: 0, total: items.length, createdAt: Date.now() };
  verifyJobs.set(id, job);
  if (items.length) runVerifyJob(job, c.token, items);
  res.json({ jobId: id, total: items.length });
});

app.get('/api/verify/:id', (req, res) => {
  const job = verifyJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Check not found.' });
  res.json({ status: job.status, done: job.done, failed: job.failed, total: job.total, error: job.error || null, lastError: job.lastError || null });
});

app.get('/api/tag/:id', (req, res) => {
  const job = tagJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Tag job not found.' });
  res.json({ status: job.status, done: job.done, failed: job.failed, total: job.total, tag: job.tag, error: job.error || null, lastError: job.lastError || null });
});

// A token proves the caller can act for this sub-account: it must work against
// GHL for that location before a schedule is shown, changed or removed.
async function authed(req, res) {
  const c = creds(req, res);
  if (!c) return null;
  try {
    const qs = new URLSearchParams({ locationId: c.locationId, limit: '1' });
    await ghl(c.token, 'GET', `/conversations/search?${qs}`, CONVERSATIONS_VERSION);
    return c;
  } catch (err) {
    res.status(err.status === 401 || err.status === 403 ? 401 : 502).json({ error: err.message });
    return null;
  }
}

app.post('/api/schedule/get', async (req, res) => {
  const c = await authed(req, res);
  if (!c) return;
  const s = await store.get(c.locationId);
  res.json({ schedule: publicSchedule(s), storage: store.kind });
});

app.post('/api/schedule/save', async (req, res) => {
  const c = await authed(req, res);
  if (!c) return;
  const b = req.body || {};
  const time = String(b.time || '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return res.status(400).json({ error: 'Pick a time.' });
  const timezone = String(b.timezone || '');
  if (!zoneOk(timezone)) return res.status(400).json({ error: 'Pick a valid timezone.' });
  const prev = (await store.get(c.locationId)) || {};
  const sched = {
    locationId: c.locationId,
    token: c.token,
    enabled: !!b.enabled,
    time, timezone,
    days: b.days === 'weekdays' ? 'weekdays' : 'daily',
    mode: b.mode === 'since' ? 'since' : 'ever',
    lookbackDays: Math.min(90, Math.max(1, Number(b.lookbackDays) || 7)),
    gapMin: Math.min(240, Math.max(1, Number(b.gapMin) || 10)),
    minSize: Math.min(100000, Math.max(2, Number(b.minSize) || 20)),
    lastBlastKey: prev.lastBlastKey || null,
    lastRun: prev.lastRun || null,
    history: prev.history || [],
    lastRunDate: prev.lastRunDate || null,
    createdAt: prev.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  // If today's run time has already passed, start tomorrow rather than right now.
  const clock = localClock(timezone);
  const changedTiming = prev.time !== time || prev.timezone !== timezone || !prev.enabled;
  if (sched.enabled && changedTiming && clock.hm >= time) sched.lastRunDate = clock.date;
  if (sched.enabled && changedTiming && clock.hm < time) sched.lastRunDate = null;
  await store.put(sched);
  res.json({ schedule: publicSchedule(sched), storage: store.kind });
});

app.post('/api/schedule/delete', async (req, res) => {
  const c = await authed(req, res);
  if (!c) return;
  await store.remove(c.locationId);
  res.json({ ok: true });
});

// "Run now" uses the saved settings and ignores the once-per-blast guard, so
// it behaves like pressing the buttons by hand.
app.post('/api/schedule/run', async (req, res) => {
  const c = await authed(req, res);
  if (!c) return;
  const s = await store.get(c.locationId);
  if (!s) return res.status(404).json({ error: 'Save the schedule first.' });
  if (running.has(c.locationId)) return res.status(409).json({ error: 'A run is already in progress.' });
  runSchedule(s, { force: true });
  res.json({ started: true });
});

app.post('/api/schedule/status', async (req, res) => {
  const c = creds(req, res);
  if (!c) return;
  const s = await store.get(c.locationId);
  if (!s || s.token !== c.token) return res.status(401).json({ error: 'Not authorized.' });
  res.json({ running: running.has(c.locationId), schedule: publicSchedule(s) });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of scans) if (now - s.createdAt > KEEP_MS) scans.delete(id);
  for (const [id, j] of tagJobs) if (now - j.createdAt > KEEP_MS) tagJobs.delete(id);
  for (const [id, j] of verifyJobs) if (now - j.createdAt > KEEP_MS) verifyJobs.delete(id);
}, 10 * 60 * 1000).unref();

store.init().then(() => {
  console.log(`schedule storage: ${store.kind}`);
  setInterval(tick, TICK_MS).unref();
  setTimeout(tick, 5000).unref();
  const campaignEvery = Number(process.env.CAMPAIGN_TICK_MS || 2 * 60000);
  setInterval(campaign.tick, campaignEvery).unref();
  setTimeout(campaign.tick, 8000).unref();
  app.listen(PORT, () => console.log(`blast-no-reply-finder listening on ${PORT}`));
}).catch((err) => { console.error('storage init failed:', err.message); process.exit(1); });
