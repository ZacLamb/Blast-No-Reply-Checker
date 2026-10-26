// Blast No-Reply Finder
// Scans a GHL sub-account for conversations whose LAST message is an outbound
// SMS, groups them into bursts (a blast = many texts sent close together),
// reads each contact's message history to drop anyone who has replied, and
// tags the rest.
//
// Login, billing and GHL credentials come from the RGS Tools Hub. The user picks
// a connected sub-account; the server asks the hub for its token per request,
// and again at run time for schedules — so no token is ever stored here.
// Schedules use Postgres when DATABASE_URL is set, else a JSON file in DATA_DIR.

const express = require('express');
const cookieParser = require('cookie-parser');
const hub = require('./hub-client')({ toolSlug: 'blast-tools' });
// GHL API usage per sub-account (Backup & Insights › Usage): tokens from the hub are mapped to their
// sub-account, and ghl() records the rate-limit headers of every response, retries included.
const apiUsage = require('./ghl-usage')({ tool: 'blast-tools' });
apiUsage.bindHub(hub);
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
        signal: AbortSignal.timeout(60000), // a stalled GHL call can't hang a job forever
      });
    } catch (err) {
      if (attempt < 4) { await sleep(1000 * (attempt + 1)); continue; }
      throw new Error(`Could not reach GHL: ${err.message}`);
    }
    apiUsage.record(res, { token });
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

// ---------- Unanswered replies ----------
// Conversations whose LAST message is inbound: the contact texted (or called, emailed,
// chatted) and nobody in the sub-account has answered since. Opt-out words are left out,
// since those don't need a reply.

const unansweredJobs = new Map(); // jobId -> { status, scanned, items, error, createdAt, owner, locationId, days, channel }
const OPT_OUT = /^\s*(stop|stopall|unsubscribe|end|quit|cancel|optout|opt out|remove)\s*[.!]*\s*$/i;

async function runUnanswered(job, { token, locationId, days, channel, minWaitMin }) {
  const cutoff = Date.now() - days * 86400000;
  const newest = Date.now() - minWaitMin * 60000;
  const seen = new Set();
  const byContact = new Map();
  try {
    const types = channel === 'sms' ? ['TYPE_SMS'] : [null];
    for (const type of types) {
      let cursor = null;
      for (let page = 0; page < 400; page++) {
        const qs = new URLSearchParams({ locationId, limit: '100', sort: 'desc', sortBy: 'last_message_date', lastMessageDirection: 'inbound' });
        if (type) qs.set('lastMessageType', type);
        if (cursor !== null) qs.set('startAfterDate', String(cursor));
        const data = await ghl(token, 'GET', `/conversations/search?${qs}`, CONVERSATIONS_VERSION);
        const list = data.conversations || [];
        if (!list.length) break;
        let fresh = 0, oldest = Infinity;
        for (const c of list) {
          const ts = tsOf(c);
          if (ts < oldest) oldest = ts;
          if (seen.has(c.id)) continue;
          seen.add(c.id); fresh++;
          const mtype = String(c.lastMessageType || '');
          if (!c.contactId || c.lastMessageDirection === 'outbound') continue;
          if (mtype.startsWith('TYPE_ACTIVITY') || mtype === 'TYPE_INTERNAL_COMMENTS') continue;
          if (ts < cutoff || ts > newest) continue;
          job.optOuts = job.optOuts || 0;
          if (OPT_OUT.test(c.lastMessageBody || '')) { job.optOuts++; continue; }
          const prev = byContact.get(c.contactId);
          if (prev && prev.ts >= ts) continue;
          byContact.set(c.contactId, {
            conversationId: c.id, contactId: c.contactId,
            name: c.fullName || c.contactName || '', phone: c.phone || '', email: c.email || '',
            body: c.lastMessageBody || '', type: mtype.replace(/^TYPE_/, '').toLowerCase(), ts,
            unread: Number(c.unreadCount) || 0,
          });
        }
        job.scanned = byContact.size;
        if (oldest < cutoff) break;
        if (fresh === 0) { if (cursor === oldest) break; cursor = oldest; } else { cursor = oldest + 1; }
      }
    }
    job.items = [...byContact.values()].sort((a, b) => a.ts - b.ts); // longest wait first
    job.status = 'done';
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
  }
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
    async get(key) { const r = await pool.query('SELECT data FROM schedules WHERE location_id = $1', [key]); return r.rows[0]?.data || null; },
    async put(sched) { await pool.query('INSERT INTO schedules (location_id, data, updated_at) VALUES ($1, $2, now()) ON CONFLICT (location_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()', [sched.key, sched]); },
    async remove(key) { await pool.query('DELETE FROM schedules WHERE location_id = $1', [key]); },
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
    async get(key) { return load()[key] || null; },
    async put(sched) { load()[sched.key] = sched; save(); },
    async remove(key) { delete load()[key]; save(); },
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

function publicSchedule(s) { return s || null; }

const running = new Set();

// The whole flow, unattended: latest blast -> reply check -> tag.
async function runSchedule(sched, { force = false } = {}) {
  if (running.has(sched.key)) return { skipped: 'already running' };
  running.add(sched.key);
  const started = Date.now();
  const result = { at: started, ok: false };
  try {
    let token;
    try { token = (await hub.credentialsFor(sched.userId, sched.locationId)).pit; }
    catch (e) { throw new Error(e.status === 404 ? 'This sub-account is no longer connected to your account.' : `Could not get credentials from the hub: ${e.message}`); }
    const scan = { status: 'running', scanned: 0, items: [] };
    await runScan(scan, { token, locationId: sched.locationId, days: sched.lookbackDays });
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
    const v = await verifyAll(token, inBlast);
    const sel = selectContacts(scan, b.from, b.to, '', sched.mode);
    const tag = tagFor(b.to, sched.timezone);
    const job = { status: 'running', done: 0, failed: 0, total: sel.contacts.length, tag };
    if (sel.contacts.length) await runTagJob(job, token, sel.contacts, tag);
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
    running.delete(sched.key);
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
    let entitled = null; // userId -> Set(locationId), fetched once per tick when something is due
    for (const sched of await store.all()) {
      if (!sched.key || !sched.userId) continue; // legacy rows from the token era are ignored
      if (!isDue(sched)) continue;
      if (!entitled) {
        entitled = new Map();
        for (const u of await hub.entitledUsers()) entitled.set(u.userId, new Set(u.connections.map((c) => c.location_id)));
      }
      if (!entitled.get(sched.userId)?.has(sched.locationId)) { console.log(`[schedule] skipping ${sched.key}: not entitled or disconnected`); continue; }
      sched.lastRunDate = localClock(sched.timezone).date;
      await store.put(sched);
      console.log(`[schedule] running ${sched.key}`);
      const r = await runSchedule(sched);
      console.log(`[schedule] ${sched.key}: ${r.outcome || r.skipped} - ${r.message || ''}`);
    }
  } catch (err) {
    console.error('[schedule] tick failed', err.message);
  } finally {
    ticking = false;
  }
}

// ---------- HTTP ----------

const app = express();
// Express 4 does not catch rejected promises from async handlers; pass them to the
// JSON error handler at the bottom instead of letting them crash the process.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// Background jobs run after the response is sent; a crash there records an error state.
const bg = (job, p) => Promise.resolve(p).catch((err) => {
  console.error('[job] failed', err);
  job.status = 'error';
  job.error = job.error || err.message || 'Something went wrong. Please try again.';
});
app.set('trust proxy', 1);
// Domain move: when CANONICAL_HOST is set (e.g. fields.revenuegeneratingsolutions.com), page visits that arrive on any
// other host (the old yourbizzassist.co address) get a permanent redirect there. Off until the variable is set.
// API calls, webhooks, internal calls and Railway's own *.railway.app host are never redirected.
app.use((req, res, next) => {
  const want = String(process.env.CANONICAL_HOST || '').trim().toLowerCase();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
  if (!want || !host || host === want || host === 'localhost' || host.endsWith('.railway.app') || host.endsWith('.railway.internal')) return next();
  if (!['GET', 'HEAD'].includes(req.method) || /^\/(api|internal)(\/|$)/.test(req.path)) return next();
  res.redirect(301, `https://${want}${req.originalUrl}`);
});

app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

app.get('/health', (req, res) => res.json({ ok: true, service: 'blast-tools' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/app', hub.requireToolPage, (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.get('/config.js', (req, res) => res.type('application/javascript').send(`window.HUB_URL=${JSON.stringify(hub.HUB_URL)};window.TOOL_SLUG="blast-tools";`));
app.get('/ui/:file(rgs-ui.css|rgs-shell.js)', (req, res) => res.redirect(302, `${hub.HUB_URL}/ui/${req.params.file}`));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Every API route needs a hub session + entitlement (or admin). 401/402 come back as JSON.
app.use('/api', hub.requireTool);
app.get('/api/me', hub.me);

// The offer-campaign module (campaign.js) is parked: not mounted until it is moved onto
// hub credentials too. Its routes took a raw token in the body, so leaving it unmounted
// is what locks it.

// Sub-account token for this request, from the hub. The location must be one the
// logged-in user has connected.
async function creds(req, res, forcedLocationId) {
  const locationId = String(forcedLocationId || req.body?.locationId || req.query?.locationId || '').trim();
  if (!locationId) { res.status(400).json({ error: 'Pick a sub-account first.' }); return null; }
  try {
    const c = await hub.credentials(req, locationId);
    return { token: c.pit, locationId: c.locationId };
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
    return null;
  }
}

const schedKey = (req, locationId) => `${req.hubUser.id}:${locationId}`;

function getScan(req, res) {
  const scan = scans.get(req.params.id);
  if (!scan || scan.owner !== req.hubUser.id) { res.status(404).json({ error: 'That scan has expired. Run the search again.' }); return null; }
  return scan;
}
function ownedJob(map, req, res, label) {
  const job = map.get(req.params.id);
  if (!job || job.owner !== req.hubUser.id) { res.status(404).json({ error: `${label} not found.` }); return null; }
  return job;
}

function range(q) {
  return { from: Number(q.from), to: Number(q.to), contains: String(q.contains || ''), mode: q.mode === 'since' ? 'since' : 'ever' };
}

app.post('/api/scan', wrap(async (req, res) => {
  const c = await creds(req, res);
  if (!c) return;
  const days = Math.min(90, Math.max(1, Number(req.body.days) || 7));
  const id = crypto.randomUUID();
  const scan = { status: 'running', scanned: 0, items: [], createdAt: Date.now(), days, owner: req.hubUser.id, locationId: c.locationId };
  scans.set(id, scan);
  bg(scan, runScan(scan, { ...c, days }));
  res.json({ scanId: id });
}));

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

app.post('/api/scan/:id/tag', wrap(async (req, res) => {
  const scan = getScan(req, res);
  if (!scan) return;
  const c = await creds(req, res, scan.locationId);
  if (!c) return;
  const tag = String(req.body.tag || '').trim().toLowerCase();
  if (!tag) return res.status(400).json({ error: 'Enter a tag name.' });
  const { from, to, contains, mode } = range(req.body);
  const { contacts } = selectContacts(scan, from, to, contains, mode);
  if (!contacts.length) return res.status(400).json({ error: 'No contacts match that selection.' });
  const id = crypto.randomUUID();
  const job = { status: 'running', done: 0, failed: 0, total: contacts.length, tag, createdAt: Date.now(), owner: req.hubUser.id };
  tagJobs.set(id, job);
  bg(job, runTagJob(job, c.token, contacts, tag));
  res.json({ jobId: id, total: contacts.length });
}));

app.post('/api/scan/:id/verify', wrap(async (req, res) => {
  const scan = getScan(req, res);
  if (!scan) return;
  const c = await creds(req, res, scan.locationId);
  if (!c) return;
  const from = Number(req.body.from), to = Number(req.body.to);
  const items = scan.items.filter((it) => it.ts >= from && it.ts <= to && !it.checked);
  const id = crypto.randomUUID();
  const job = { status: items.length ? 'running' : 'done', done: 0, failed: 0, total: items.length, createdAt: Date.now(), owner: req.hubUser.id };
  verifyJobs.set(id, job);
  if (items.length) bg(job, runVerifyJob(job, c.token, items));
  res.json({ jobId: id, total: items.length });
}));

app.get('/api/verify/:id', (req, res) => {
  const job = ownedJob(verifyJobs, req, res, 'Check');
  if (!job) return;
  res.json({ status: job.status, done: job.done, failed: job.failed, total: job.total, error: job.error || null, lastError: job.lastError || null });
});

app.get('/api/tag/:id', (req, res) => {
  const job = ownedJob(tagJobs, req, res, 'Tag job');
  if (!job) return;
  res.json({ status: job.status, done: job.done, failed: job.failed, total: job.total, tag: job.tag, error: job.error || null, lastError: job.lastError || null });
});

// ---------- Unanswered replies routes ----------
app.post('/api/unanswered', wrap(async (req, res) => {
  const c = await creds(req, res);
  if (!c) return;
  const days = Math.min(90, Math.max(1, Number(req.body.days) || 7));
  const channel = req.body.channel === 'all' ? 'all' : 'sms';
  const minWaitMin = Math.min(7 * 1440, Math.max(0, Number(req.body.minWait) || 0));
  const id = crypto.randomUUID();
  const job = { status: 'running', scanned: 0, items: [], createdAt: Date.now(), owner: req.hubUser.id, locationId: c.locationId, days, channel, minWaitMin };
  unansweredJobs.set(id, job);
  bg(job, runUnanswered(job, { ...c, days, channel, minWaitMin }));
  res.json({ id });
}));

app.get('/api/unanswered/:id', (req, res) => {
  const job = ownedJob(unansweredJobs, req, res, 'Check');
  if (!job) return;
  const out = { status: job.status, scanned: job.scanned, error: job.error || null, locationId: job.locationId };
  if (job.status === 'done') {
    out.count = job.items.length;
    out.optOuts = job.optOuts || 0;
    out.oldest = job.items[0]?.ts || null;
    out.rows = job.items.slice(0, 300).map(({ conversationId, contactId, name, phone, email, body, type, ts, unread, answered }) => ({ conversationId, contactId, name, phone, email, body, type, ts, unread, answered: answered || null }));
  }
  res.json(out);
});

app.get('/api/unanswered/:id/contacts.csv', (req, res) => {
  const job = ownedJob(unansweredJobs, req, res, 'Check');
  if (!job) return;
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const esc = (v) => q(String(v ?? '').replace(/^([=+\-@])/, "'$1"));
  const rows = [['Contact ID', 'Name', 'Phone', 'Email', 'Channel', 'Their last message', 'Sent at (UTC)', 'Waiting (hours)'].map(esc).join(',')];
  for (const it of job.items) {
    rows.push([q(it.contactId), esc(it.name), q(it.phone), q(it.email), q(it.type), esc(it.body), q(new Date(it.ts).toISOString()), q(((Date.now() - it.ts) / 3600000).toFixed(1))].join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="unanswered-replies.csv"');
  res.send(rows.join('\n'));
});

// Full message history for one waiting contact, oldest first (up to 300 messages).
app.get('/api/unanswered/:id/conversation/:cid', wrap(async (req, res) => {
  const job = ownedJob(unansweredJobs, req, res, 'Check');
  if (!job) return;
  const it = job.items.find((x) => x.conversationId === req.params.cid);
  if (!it) return res.status(404).json({ error: 'That conversation is not in this check. Run it again.' });
  const c = await creds(req, res, job.locationId);
  if (!c) return;
  const out = [];
  let lastMessageId = null, more = false;
  for (let page = 0; page < 3; page++) {
    const qs = new URLSearchParams({ limit: '100' });
    if (lastMessageId) qs.set('lastMessageId', lastMessageId);
    const data = await ghl(c.token, 'GET', `/conversations/${encodeURIComponent(it.conversationId)}/messages?${qs}`, CONVERSATIONS_VERSION);
    const box = data.messages || {};
    const list = box.messages || [];
    for (const m of list) {
      const call = m.meta?.call || {};
      out.push({
        id: m.id, direction: m.direction || '', type: String(m.messageType || '').replace(/^TYPE_/, '').toLowerCase(),
        body: m.body || '', at: m.dateAdded || null, status: m.status || '',
        attachments: (m.attachments || []).filter((u) => typeof u === 'string').slice(0, 10),
        callStatus: call.status || '', callSeconds: Number(call.duration) || 0,
        subject: m.meta?.email?.subject || '',
      });
    }
    more = !!box.nextPage;
    if (!box.nextPage || !list.length || !box.lastMessageId || box.lastMessageId === lastMessageId) break;
    lastMessageId = box.lastMessageId;
  }
  out.sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0));
  res.json({ contact: { name: it.name, phone: it.phone, email: it.email, contactId: it.contactId, conversationId: it.conversationId, answered: it.answered || null }, locationId: job.locationId, messages: out, more });
}));

// ---------- Opportunities for a waiting contact ----------
// Viewing needs opportunities.readonly; changing needs opportunities.write. Assigning a rep
// reads the user list (users.readonly) when the token has it; otherwise that picker is hidden.
const OPP_STATUSES = ['open', 'won', 'lost', 'abandoned'];
const oppErr = (err) => (err.status === 401 || err.status === 403)
  ? { status: 403, error: 'This sub-account can\'t edit opportunities from here yet. Add a Private Integration token on the hub that includes Opportunities › Edit (plus the usual RGS Tools permissions), or update it in GHL.' }
  : { status: err.status && err.status < 500 ? 400 : 502, error: err.message.replace(/^GHL returned \d+: /, 'GHL: ') };
function oppItem(job, cid) { return job.items.find((x) => x.conversationId === String(cid || '')); }
const slimOpp = (o) => ({ id: o.id, name: o.name || '', pipelineId: o.pipelineId, stageId: o.pipelineStageId, status: o.status, value: Number(o.monetaryValue) || 0, assignedTo: o.assignedTo || '', updatedAt: o.updatedAt || o.lastStatusChangeAt || null });

app.get('/api/unanswered/:id/opps/:cid', wrap(async (req, res) => {
  const job = ownedJob(unansweredJobs, req, res, 'Check');
  if (!job) return;
  const it = oppItem(job, req.params.cid);
  if (!it) return res.status(404).json({ error: 'That conversation is not in this check. Run it again.' });
  const c = await creds(req, res, job.locationId);
  if (!c) return;
  try {
    const loc = encodeURIComponent(job.locationId);
    const [p, o] = await Promise.all([
      ghl(c.token, 'GET', `/opportunities/pipelines?locationId=${loc}`, CONTACTS_VERSION),
      ghl(c.token, 'GET', `/opportunities/search?location_id=${loc}&contact_id=${encodeURIComponent(it.contactId)}&limit=100`, CONTACTS_VERSION),
    ]);
    let users = [];
    try {
      const u = await ghl(c.token, 'GET', `/users/?locationId=${loc}`, CONTACTS_VERSION);
      users = (u.users || []).map((x) => ({ id: x.id, name: [x.firstName, x.lastName].filter(Boolean).join(' ') || x.name || x.email || x.id })).sort((a, b) => a.name.localeCompare(b.name));
    } catch { /* no users scope: assignment picker is hidden */ }
    res.json({
      pipelines: (p.pipelines || []).map((x) => ({ id: x.id, name: x.name, stages: (x.stages || []).map((s) => ({ id: s.id, name: s.name })) })),
      opportunities: (o.opportunities || []).filter((x) => !x.contactId || x.contactId === it.contactId || x.contact?.id === it.contactId).map(slimOpp),
      users,
      contactName: it.name || '',
    });
  } catch (err) {
    if (err.status === 401 || err.status === 403) return res.status(403).json({ error: 'This sub-account can\'t read opportunities from here. Reconnect it with a token that includes Opportunities › View.' });
    const e = oppErr(err); res.status(e.status).json({ error: e.error });
  }
}));

app.put('/api/unanswered/:id/opps/:oppId', wrap(async (req, res) => {
  const job = ownedJob(unansweredJobs, req, res, 'Check');
  if (!job) return;
  const it = oppItem(job, req.body.conversationId);
  if (!it) return res.status(404).json({ error: 'That conversation is not in this check. Run it again.' });
  const c = await creds(req, res, job.locationId);
  if (!c) return;
  try {
    const cur = await ghl(c.token, 'GET', `/opportunities/${encodeURIComponent(req.params.oppId)}`, CONTACTS_VERSION);
    const opp = cur.opportunity || cur;
    if ((opp.contactId || opp.contact?.id) !== it.contactId) return res.status(400).json({ error: 'That opportunity belongs to a different contact.' });
    const b = req.body || {};
    const body = {};
    if (b.pipelineId) body.pipelineId = String(b.pipelineId);
    if (b.stageId) body.pipelineStageId = String(b.stageId);
    if (b.status !== undefined) { if (!OPP_STATUSES.includes(b.status)) return res.status(400).json({ error: 'Unknown status.' }); body.status = b.status; }
    if (b.value !== undefined && b.value !== '') { const v = Number(b.value); if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: 'Enter a value of 0 or more.' }); body.monetaryValue = v; }
    if (b.assignedTo !== undefined) body.assignedTo = String(b.assignedTo || '');
    if (b.name !== undefined && String(b.name).trim()) body.name = String(b.name).trim().slice(0, 200);
    if (!Object.keys(body).length) return res.status(400).json({ error: 'Nothing to change.' });
    if (body.pipelineStageId && !body.pipelineId) body.pipelineId = opp.pipelineId;
    const d = await ghl(c.token, 'PUT', `/opportunities/${encodeURIComponent(req.params.oppId)}`, CONTACTS_VERSION, body);
    res.json({ ok: true, opportunity: slimOpp(d.opportunity || { ...opp, ...body }) });
  } catch (err) { const e = oppErr(err); res.status(e.status).json({ error: e.error }); }
}));

app.post('/api/unanswered/:id/opps', wrap(async (req, res) => {
  const job = ownedJob(unansweredJobs, req, res, 'Check');
  if (!job) return;
  const it = oppItem(job, req.body.conversationId);
  if (!it) return res.status(404).json({ error: 'That conversation is not in this check. Run it again.' });
  const b = req.body || {};
  if (!b.pipelineId || !b.stageId) return res.status(400).json({ error: 'Pick a pipeline and stage.' });
  const c = await creds(req, res, job.locationId);
  if (!c) return;
  const body = {
    locationId: job.locationId, contactId: it.contactId, pipelineId: String(b.pipelineId), pipelineStageId: String(b.stageId),
    name: String(b.name || it.name || it.phone || 'New opportunity').trim().slice(0, 200), status: 'open',
  };
  const v = Number(b.value); if (b.value !== undefined && b.value !== '' && Number.isFinite(v) && v >= 0) body.monetaryValue = v;
  if (b.assignedTo) body.assignedTo = String(b.assignedTo);
  try {
    const d = await ghl(c.token, 'POST', '/opportunities/', CONTACTS_VERSION, body);
    res.json({ ok: true, opportunity: slimOpp(d.opportunity || d) });
  } catch (err) { const e = oppErr(err); res.status(e.status).json({ error: e.error }); }
}));

// Reply by text from the dashboard. Needs the conversations/message.write scope: a
// sub-account connected before that scope was added has to be reconnected on the hub.
app.post('/api/unanswered/:id/reply', wrap(async (req, res) => {
  const job = ownedJob(unansweredJobs, req, res, 'Check');
  if (!job) return;
  const it = job.items.find((x) => x.conversationId === String(req.body.conversationId || ''));
  if (!it) return res.status(404).json({ error: 'That conversation is not in this check. Run it again.' });
  const message = String(req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Type a message first.' });
  if (message.length > 1600) return res.status(400).json({ error: 'That message is too long for a text (1,600 characters max).' });
  if (!it.phone) return res.status(400).json({ error: 'This contact has no phone number. Reply in GHL instead.' });
  const c = await creds(req, res, job.locationId);
  if (!c) return;
  try {
    const d = await ghl(c.token, 'POST', '/conversations/messages', CONVERSATIONS_VERSION, { type: 'SMS', contactId: it.contactId, message });
    it.answered = Date.now();
    res.json({ ok: true, messageId: d.messageId || d.msg?.id || null });
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      return res.status(403).json({ error: 'This sub-account can\'t send messages from here yet. In the sub-account, create a Private Integration token that includes Conversations › Send messages (plus the usual RGS Tools permissions), then add it on the hub under Sub-accounts. Or reply in GHL with the link on the right.', needsReconnect: true });
    }
    res.status(err.status && err.status < 500 ? 400 : 502).json({ error: err.message.replace(/^GHL returned \d+: /, 'GHL: ') });
  }
}));

app.post('/api/unanswered/:id/tag', wrap(async (req, res) => {
  const job = ownedJob(unansweredJobs, req, res, 'Check');
  if (!job) return;
  if (job.status !== 'done') return res.status(409).json({ error: 'The check is not finished yet.' });
  const c = await creds(req, res, job.locationId);
  if (!c) return;
  const tag = String(req.body.tag || '').trim().toLowerCase();
  if (!tag) return res.status(400).json({ error: 'Enter a tag name.' });
  const waiting = job.items.filter((x) => !x.answered);
  if (!waiting.length) return res.status(400).json({ error: 'Nobody is waiting on a reply.' });
  const id = crypto.randomUUID();
  const t = { status: 'running', done: 0, failed: 0, total: waiting.length, tag, createdAt: Date.now(), owner: req.hubUser.id };
  tagJobs.set(id, t);
  bg(t, runTagJob(t, c.token, waiting, tag));
  res.json({ jobId: id, total: waiting.length });
}));

// Schedules belong to the hub user + sub-account; the hub already proved the
// user owns that connection, so no GHL round-trip is needed here.
async function authed(req, res) {
  const locationId = String(req.body?.locationId || '').trim();
  if (!locationId) { res.status(400).json({ error: 'Pick a sub-account first.' }); return null; }
  if (!(req.hubUser.connections || []).some((x) => x.location_id === locationId)) { res.status(400).json({ error: 'That sub-account is not connected to your account.' }); return null; }
  return { locationId, key: schedKey(req, locationId) };
}

app.post('/api/schedule/get', wrap(async (req, res) => {
  const c = await authed(req, res);
  if (!c) return;
  const s = await store.get(c.key);
  res.json({ schedule: publicSchedule(s), storage: store.kind });
}));

app.post('/api/schedule/save', wrap(async (req, res) => {
  const c = await authed(req, res);
  if (!c) return;
  const b = req.body || {};
  const time = String(b.time || '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return res.status(400).json({ error: 'Pick a time.' });
  const timezone = String(b.timezone || '');
  if (!zoneOk(timezone)) return res.status(400).json({ error: 'Pick a valid timezone.' });
  const prev = (await store.get(c.key)) || {};
  const sched = {
    key: c.key,
    userId: req.hubUser.id,
    locationId: c.locationId,
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
}));

app.post('/api/schedule/delete', wrap(async (req, res) => {
  const c = await authed(req, res);
  if (!c) return;
  await store.remove(c.key);
  res.json({ ok: true });
}));

// "Run now" uses the saved settings and ignores the once-per-blast guard, so
// it behaves like pressing the buttons by hand.
app.post('/api/schedule/run', wrap(async (req, res) => {
  const c = await authed(req, res);
  if (!c) return;
  const s = await store.get(c.key);
  if (!s) return res.status(404).json({ error: 'Save the schedule first.' });
  if (running.has(c.key)) return res.status(409).json({ error: 'A run is already in progress.' });
  runSchedule(s, { force: true }).catch((err) => console.error('[schedule] run failed', err));
  res.json({ started: true });
}));

app.post('/api/schedule/status', wrap(async (req, res) => {
  const c = await authed(req, res);
  if (!c) return;
  const s = await store.get(c.key);
  res.json({ running: running.has(c.key), schedule: publicSchedule(s) });
}));

// Anything thrown above (hub outage, storage error) comes back as JSON, never a crash or a hang.
app.use((err, req, res, next) => {
  const status = err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error(`[http] ${req.method} ${req.originalUrl}`, err);
  if (res.headersSent) return res.end();
  const msg = err.type === 'entity.parse.failed' ? 'The request was not valid JSON.' : err.expose ? err.message : 'Something went wrong on our side. Please try again.';
  res.status(status).json({ error: msg });
});

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of scans) if (now - s.createdAt > KEEP_MS) scans.delete(id);
  for (const [id, j] of tagJobs) if (now - j.createdAt > KEEP_MS) tagJobs.delete(id);
  for (const [id, j] of verifyJobs) if (now - j.createdAt > KEEP_MS) verifyJobs.delete(id);
  for (const [id, j] of unansweredJobs) if (now - j.createdAt > KEEP_MS) unansweredJobs.delete(id);
}, 10 * 60 * 1000).unref();

store.init().then(() => {
  console.log(`schedule storage: ${store.kind}`);
  setInterval(tick, TICK_MS).unref(); // tick() catches its own errors
  setTimeout(tick, 5000).unref();
  app.listen(PORT, () => console.log(`blast-tools listening on ${PORT}`));
}).catch((err) => { console.error('storage init failed:', err.message); process.exit(1); });
