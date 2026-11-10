// Multi-Number SMS: GHL's bulk "Send SMS" and workflow SMS only text a contact's primary phone. This
// sends the same text to their other numbers too.
//
// How it's used: the client bulk-selects contacts → Add to Workflow → the workflow's Webhook action
// POSTs { contactId, locationId, message, mode } to this tool's hook URL (one secret URL per
// sub-account, shown in the tool). Each request is queued in Postgres and worked through per
// sub-account at GHL's pace: read the contact, collect its numbers, skip it entirely if it's on Do Not
// Disturb, then send one SMS per number with toNumber set, logging every send.
//
// Until "Live sending" is switched on for a sub-account, requests run as a dry run: everything is
// worked out and logged as "would send", nothing is sent. That's how to check a workflow is wired up
// before texting anyone, and the switch stays off until toNumber is proven on that sub-account.

const MODES = ['primary', 'all', 'additional'];
const DEFAULT_CC = String(process.env.DEFAULT_COUNTRY_CODE || '1').replace(/\D/g, '') || '1';

// ---------- pure helpers (tested) ----------

// Phone → E.164 (+15085551234), or null if it can't be a real number. 10 digits get the default
// country code; 11 starting with it are taken as already having it.
function e164(raw, cc = DEFAULT_CC) {
  let s = String(raw || '').trim();
  if (!s) return null;
  s = s.replace(/(?:ext\.?|x|#)\s*\d+$/i, '');           // drop extensions
  const plus = s.startsWith('+') || s.startsWith('00');
  let d = s.replace(/\D/g, '');
  if (s.startsWith('00')) d = d.slice(2);
  if (!plus) {
    if (d.length === 10) d = cc + d;
    else if (!(d.length === 10 + cc.length && d.startsWith(cc))) return null;
  }
  if (d.length < 8 || d.length > 15 || /^0/.test(d)) return null;
  if (cc === '1' && d.startsWith('1') && d.length === 11 && /^[01]/.test(d.slice(1))) return null;   // NANP area codes can't start with 0/1
  return '+' + d;
}

// Every phone on a GHL contact, wherever the API put it: phone, additionalPhones (strings or
// { phone }), phones[]. Primary first. -> { primary, additional: [...] } already E.164 and deduped.
function phonesOf(contact, cc = DEFAULT_CC) {
  const c = contact || {};
  const primary = e164(c.phone, cc);
  const extra = [];
  for (const list of [c.additionalPhones, c.phones, c.additionalPhoneNumbers]) {
    if (!Array.isArray(list)) continue;
    for (const p of list) extra.push(typeof p === 'string' ? p : p?.phone || p?.number || p?.value);
  }
  const seen = new Set(primary ? [primary] : []);
  const additional = [];
  for (const raw of extra) { const n = e164(raw, cc); if (n && !seen.has(n)) { seen.add(n); additional.push(n); } }
  return { primary, additional };
}

function numbersFor(contact, mode, cc = DEFAULT_CC) {
  const { primary, additional } = phonesOf(contact, cc);
  if (mode === 'primary') return primary ? [primary] : [];
  if (mode === 'additional') return additional;
  return [...(primary ? [primary] : []), ...additional];
}

// Do Not Disturb: the global switch, SMS DND, or an opt-out tag. Any of them skips every number.
function onDnd(contact) {
  const c = contact || {};
  if (c.dnd === true) return 'Do Not Disturb is on';
  const sms = c.dndSettings?.SMS || c.dndSettings?.sms;
  if (sms && String(sms.status || '').toLowerCase() === 'active') return 'SMS Do Not Disturb is on';
  const tags = (c.tags || []).map((t) => String(t).toLowerCase());
  if (tags.some((t) => /^(stop|dnd|opted[ _-]?out|unsubscribed?)$/.test(t))) return 'Has an opt-out tag';
  return null;
}

// {{contact.first_name}} and friends. GHL renders merge fields in a webhook body before sending, so
// this only matters when a raw template reaches us; unknown fields become empty, not "{{…}}".
function render(template, contact, customByKey = {}) {
  const c = contact || {};
  const std = {
    first_name: c.firstName, last_name: c.lastName, name: c.contactName || c.name || [c.firstName, c.lastName].filter(Boolean).join(' '),
    full_name: [c.firstName, c.lastName].filter(Boolean).join(' '), email: c.email, phone: c.phone, company_name: c.companyName,
    city: c.city, state: c.state, postal_code: c.postalCode, address1: c.address1, country: c.country, website: c.website, source: c.source,
  };
  const custom = {};
  for (const f of c.customFields || c.customField || []) { const key = customByKey[f.id]; if (key) custom[key] = Array.isArray(f.value) ? f.value.join(', ') : f.value; }
  return String(template || '').replace(/\{\{\s*contact\.([a-z0-9_.]+)\s*\}\}/gi, (_, k) => {
    const key = k.toLowerCase();
    const v = std[key] ?? custom[key] ?? custom[`contact.${key}`];
    return v == null ? '' : String(v);
  });
}

// Pull the four fields out of whatever the workflow sent: a Custom Webhook body, the standard
// webhook payload (contact fields at the top level, location { id }), or customData.
function parseHook(body) {
  const b = body || {};
  const cd = b.customData || b.custom_data || {};
  const pick = (...v) => v.find((x) => x != null && String(x).trim() !== '');
  const mode = String(pick(b.mode, cd.mode, 'all')).toLowerCase().trim();
  return {
    contactId: String(pick(b.contactId, b.contact_id, cd.contactId, b.contact?.id, b.id) || '').trim(),
    locationId: String(pick(b.locationId, b.location_id, cd.locationId, b.location?.id) || '').trim(),
    message: String(pick(b.message, cd.message, b.body, '') || ''),
    mode: MODES.includes(mode) ? mode : null,
  };
}

// ---------- queue + worker ----------

function create({ pool, ghl, hub, CONTACTS_VERSION, CONVERSATIONS_VERSION, log = console }) {
  const crypto = require('crypto');

  async function init() {
    await pool.query(`CREATE TABLE IF NOT EXISTS msms_hooks (
      key TEXT PRIMARY KEY, owner TEXT NOT NULL, location_id TEXT NOT NULL, live BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (owner, location_id))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS msms_requests (
      id BIGSERIAL PRIMARY KEY, hook_key TEXT NOT NULL, owner TEXT NOT NULL, location_id TEXT NOT NULL,
      contact_id TEXT NOT NULL, message TEXT NOT NULL, mode TEXT NOT NULL, live BOOLEAN NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',       -- queued | done | skipped | failed
      note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), done_at TIMESTAMPTZ)`);
    await pool.query('CREATE INDEX IF NOT EXISTS msms_requests_queue ON msms_requests (location_id, id) WHERE status = \'queued\'');
    await pool.query(`CREATE TABLE IF NOT EXISTS msms_sends (
      id BIGSERIAL PRIMARY KEY, request_id BIGINT NOT NULL, owner TEXT NOT NULL, location_id TEXT NOT NULL,
      contact_id TEXT NOT NULL, contact_name TEXT, number TEXT NOT NULL, is_primary BOOLEAN NOT NULL DEFAULT false,
      status TEXT NOT NULL,                         -- sent | failed | would_send
      message_id TEXT, error TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query('CREATE INDEX IF NOT EXISTS msms_sends_loc ON msms_sends (owner, location_id, at DESC)');
  }

  // ---- hook URLs (one per user + sub-account) ----
  async function hookFor(owner, locationId) {
    const { rows: [r] } = await pool.query('SELECT key, live FROM msms_hooks WHERE owner=$1 AND location_id=$2', [String(owner), locationId]);
    if (r) return r;
    const key = crypto.randomBytes(18).toString('base64url');
    const { rows: [n] } = await pool.query(`INSERT INTO msms_hooks (key, owner, location_id) VALUES ($1,$2,$3)
      ON CONFLICT (owner, location_id) DO UPDATE SET owner=EXCLUDED.owner RETURNING key, live`, [key, String(owner), locationId]);
    return n;
  }
  async function setLive(owner, locationId, live) {
    await hookFor(owner, locationId);
    await pool.query('UPDATE msms_hooks SET live=$3 WHERE owner=$1 AND location_id=$2', [String(owner), locationId, !!live]);
  }
  async function rotate(owner, locationId) {
    const key = crypto.randomBytes(18).toString('base64url');
    await pool.query('UPDATE msms_hooks SET key=$3 WHERE owner=$1 AND location_id=$2', [String(owner), locationId, key]);
    return key;
  }

  // ---- the webhook ----
  // -> { status, body }. Never throws: GHL retries non-2xx, so only a bad key or bad input is refused.
  async function receive(key, body) {
    const { rows: [h] } = await pool.query('SELECT key, owner, location_id, live FROM msms_hooks WHERE key=$1', [String(key || '')]);
    if (!h) return { status: 404, body: { error: 'Unknown hook URL. Copy it again from Blast Follow-Up › Multi-Number SMS.' } };
    const p = parseHook(body);
    if (!p.contactId) return { status: 400, body: { error: 'Missing contactId. Map {{contact.id}} to contactId in the webhook.' } };
    if (p.locationId && p.locationId !== h.location_id) return { status: 403, body: { error: 'This hook URL belongs to a different sub-account.' } };
    if (!p.message.trim()) return { status: 400, body: { error: 'Missing message.' } };
    if (!p.mode) return { status: 400, body: { error: `mode must be one of: ${MODES.join(', ')}.` } };
    if (p.message.length > 1600) return { status: 400, body: { error: 'Message is longer than 1,600 characters.' } };
    const { rows: [r] } = await pool.query(`INSERT INTO msms_requests (hook_key, owner, location_id, contact_id, message, mode, live)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [h.key, h.owner, h.location_id, p.contactId, p.message, p.mode, h.live]);
    kick();
    return { status: 202, body: { ok: true, queued: r.id, live: h.live } };
  }

  // ---- worker: one loop per sub-account, oldest first, at GHL's pace (ghl() throttles per token) ----
  const running = new Set();
  const fieldKeys = new Map();   // locationId -> { at, map: { fieldId: key } }
  let timer = null;
  function kick() { if (!timer) timer = setTimeout(async () => { timer = null; await tick().catch((e) => log.error('[msms] tick', e)); }, 200); }

  async function tick() {
    const { rows } = await pool.query(`SELECT DISTINCT location_id, owner FROM msms_requests WHERE status='queued'`);
    for (const { location_id: loc, owner } of rows) {
      const k = `${owner}:${loc}`;
      if (running.has(k)) continue;
      running.add(k);
      drain(owner, loc).catch((e) => log.error('[msms] drain', loc, e.message)).finally(() => running.delete(k));
    }
  }

  async function customKeys(token, loc) {
    const hit = fieldKeys.get(loc);
    if (hit && Date.now() - hit.at < 30 * 60e3) return hit.map;
    const map = {};
    try {
      const d = await ghl(token, 'GET', `/locations/${encodeURIComponent(loc)}/customFields?model=contact`, CONTACTS_VERSION);
      for (const f of d.customFields || []) if (f.id && f.fieldKey) map[f.id] = String(f.fieldKey).replace(/^contact\./, '').toLowerCase();
    } catch { /* merge fields from custom fields just stay empty */ }
    fieldKeys.set(loc, { at: Date.now(), map });
    return map;
  }

  async function drain(owner, loc) {
    let token;
    try { token = (await hub.credentialsFor(owner, loc)).pit; }
    catch (e) {
      // No connection or no access to the tool any more: fail what's queued rather than retry forever.
      await pool.query(`UPDATE msms_requests SET status='failed', note=$3, done_at=now() WHERE owner=$1 AND location_id=$2 AND status='queued'`, [owner, loc, `No access to this sub-account: ${e.message}`.slice(0, 300)]);
      return;
    }
    for (;;) {
      const { rows: [r] } = await pool.query(`SELECT * FROM msms_requests WHERE owner=$1 AND location_id=$2 AND status='queued' ORDER BY id LIMIT 1`, [owner, loc]);
      if (!r) return;
      const done = (status, note) => pool.query('UPDATE msms_requests SET status=$2, note=$3, done_at=now() WHERE id=$1', [r.id, status, note ? String(note).slice(0, 300) : null]);
      let contact;
      try { contact = (await ghl(token, 'GET', `/contacts/${encodeURIComponent(r.contact_id)}`, CONTACTS_VERSION)).contact; }
      catch (e) { await done('failed', `Couldn't read the contact: ${e.message}`); if (e.status === 401 || e.status === 403) return; continue; }
      if (!contact) { await done('failed', 'Contact not found'); continue; }
      const dnd = onDnd(contact);
      if (dnd) { await done('skipped', `${dnd}: no numbers texted`); continue; }
      const numbers = numbersFor(contact, r.mode);
      if (!numbers.length) { await done('skipped', r.mode === 'additional' ? 'No additional numbers' : 'No valid phone numbers'); continue; }
      const text = render(r.message, contact, /\{\{/.test(r.message) ? await customKeys(token, loc) : {});
      const primary = phonesOf(contact).primary;
      const name = contact.contactName || [contact.firstName, contact.lastName].filter(Boolean).join(' ') || null;
      let sent = 0, failed = 0, fatal = null;
      for (const number of numbers) {
        const row = { status: 'would_send', messageId: null, error: null };
        if (r.live && !fatal) {
          try {
            const d = await ghl(token, 'POST', '/conversations/messages', CONVERSATIONS_VERSION, { type: 'SMS', contactId: r.contact_id, message: text, toNumber: number });
            row.status = 'sent'; row.messageId = d.messageId || d.msg?.id || null; sent++;
          } catch (e) {
            row.status = 'failed'; row.error = String(e.message || e).replace(/^GHL returned \d+: /, '').slice(0, 300); failed++;
            if (e.status === 401 || e.status === 403) fatal = 'This sub-account\'s connection can\'t send messages (it needs Conversations › Send messages). Reconnect it on the RGS Tools hub.';
          }
        } else if (r.live && fatal) { row.status = 'failed'; row.error = fatal; failed++; }
        await pool.query(`INSERT INTO msms_sends (request_id, owner, location_id, contact_id, contact_name, number, is_primary, status, message_id, error)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [r.id, owner, loc, r.contact_id, name, number, number === primary, row.status, row.messageId, row.error]);
      }
      await done(r.live ? (sent ? 'done' : 'failed') : 'done', r.live ? `${sent} sent${failed ? `, ${failed} failed` : ''}` : `Dry run: would text ${numbers.length}`);
      if (fatal) {
        await pool.query(`UPDATE msms_requests SET status='failed', note=$3, done_at=now() WHERE owner=$1 AND location_id=$2 AND status='queued'`, [owner, loc, fatal]);
        return;
      }
    }
  }

  // ---- the tool page ----
  async function summary(owner, loc) {
    const hook = await hookFor(owner, loc);
    const { rows: [q] } = await pool.query(`SELECT count(*) FILTER (WHERE status='queued')::int AS queued,
      count(*) FILTER (WHERE status='done' AND created_at > now() - interval '7 days')::int AS done7,
      count(*) FILTER (WHERE status='skipped' AND created_at > now() - interval '7 days')::int AS skipped7,
      count(*) FILTER (WHERE status='failed' AND created_at > now() - interval '7 days')::int AS failed7
      FROM msms_requests WHERE owner=$1 AND location_id=$2`, [String(owner), loc]);
    const { rows: [s] } = await pool.query(`SELECT count(*) FILTER (WHERE status='sent')::int AS sent, count(*) FILTER (WHERE status='failed')::int AS failed,
      count(*) FILTER (WHERE status='would_send')::int AS would FROM msms_sends WHERE owner=$1 AND location_id=$2 AND at > now() - interval '7 days'`, [String(owner), loc]);
    return { hookKey: hook.key, live: hook.live, requests: q, sends: s };
  }
  async function recent(owner, loc, limit = 200) {
    const { rows: reqs } = await pool.query(`SELECT id, contact_id, mode, live, status, note, created_at, done_at, left(message, 160) AS message
      FROM msms_requests WHERE owner=$1 AND location_id=$2 ORDER BY id DESC LIMIT $3`, [String(owner), loc, limit]);
    const ids = reqs.map((r) => r.id);
    const { rows: sends } = ids.length ? await pool.query('SELECT request_id, contact_name, number, is_primary, status, error, at FROM msms_sends WHERE request_id = ANY($1) ORDER BY id', [ids]) : { rows: [] };
    const by = {};
    for (const s of sends) (by[s.request_id] ||= []).push(s);
    return reqs.map((r) => ({ ...r, sends: by[r.id] || [] }));
  }
  async function sendsCsv(owner, loc) {
    const { rows } = await pool.query(`SELECT s.at, s.contact_id, s.contact_name, s.number, s.is_primary, s.status, s.error, s.message_id, r.mode, r.message
      FROM msms_sends s JOIN msms_requests r ON r.id=s.request_id WHERE s.owner=$1 AND s.location_id=$2 ORDER BY s.id DESC LIMIT 50000`, [String(owner), loc]);
    return rows;
  }

  // Queue one request straight from the tool page (the "Send a test" form): same path as the webhook.
  async function test(owner, loc, { contactId, message, mode, live }) {
    const h = await hookFor(owner, loc);
    const { rows: [r] } = await pool.query(`INSERT INTO msms_requests (hook_key, owner, location_id, contact_id, message, mode, live)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [h.key, String(owner), loc, contactId, message, MODES.includes(mode) ? mode : 'all', !!live]);
    kick();
    return r.id;
  }

  setInterval(() => tick().catch(() => {}), 15000).unref?.();   // picks up anything left after a restart
  return { init, receive, hookFor, setLive, rotate, summary, recent, sendsCsv, test, kick };
}

module.exports = { create, e164, phonesOf, numbersFor, onDnd, render, parseHook, MODES };
