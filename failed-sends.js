// Failed sends: find outbound texts that came back failed/undelivered, sort them into
// "safe to retry" and "don't retry" by the carrier error, skip anyone who has since been
// reached or replied, and resend the original text from the same number.
//
// Error codes are the standard carrier / Twilio-style codes HighLevel passes through in a
// message's `error`. Permanent problems (opt-outs, landlines, bad numbers, carrier spam
// filtering, unregistered sending) are never resent: retrying them hurts deliverability.

const RETRY = {
  30001: 'Queue overflow (temporary)',
  30003: 'Phone unreachable or off (temporary)',
  30008: 'Unknown carrier error',
  30009: 'Missing message segment',
  30017: 'Carrier congestion (temporary)',
  30022: 'Sending rate exceeded',
  30035: 'Message expired in queue',
};
const NO_RETRY = {
  21211: 'Invalid phone number',
  21408: 'Region not enabled for sending',
  21610: 'Contact opted out (replied STOP)',
  21612: 'Number can\'t receive texts from this sender',
  21614: 'Not a mobile number',
  30002: 'Sending account suspended',
  30004: 'Blocked by the recipient',
  30005: 'Unknown or inactive number',
  30006: 'Landline or unreachable carrier',
  30007: 'Filtered as spam by the carrier',
  30018: 'Destination carrier blocked the sender',
  30032: 'Toll-free number not verified',
  30034: 'Sender not registered for A2P 10DLC',
};
const TEXT_RULES = [
  [/opt(ed)?[\s-]?out|unsubscrib|\bstop\b|blacklist/i, 'Contact opted out'],
  [/landline|not a mobile|non[- ]?mobile/i, 'Not a mobile number'],
  [/invalid (phone|number|to)|not a valid/i, 'Invalid phone number'],
  [/spam|filtered|blocked/i, 'Filtered or blocked by the carrier'],
  [/10dlc|a2p|unregistered|not registered/i, 'Sender not registered for A2P 10DLC'],
  [/do not disturb|\bdnd\b/i, 'Contact is on Do Not Disturb'],
];

function classify(error) {
  const text = String(error || '');
  const m = text.match(/\b(2\d{4}|3\d{4})\b/);
  const code = m ? Number(m[1]) : null;
  if (code && RETRY[code]) return { verdict: 'retry', code, reason: RETRY[code] };
  if (code && NO_RETRY[code]) return { verdict: 'skip', code, reason: NO_RETRY[code] };
  for (const [rx, reason] of TEXT_RULES) if (rx.test(text)) return { verdict: 'skip', code, reason };
  return { verdict: 'check', code, reason: text ? text.slice(0, 120) : 'No reason given' };
}

// HighLevel stores the reason in different shapes depending on the provider (LeadConnector,
// Twilio, custom providers): a string, an object, or a separate code field.
function errText(m) {
  const parts = [];
  const add = (v) => { if (v == null || v === '') return; if (typeof v === 'object') { add(v.code); add(v.errorCode); add(v.message || v.msg || v.description); } else parts.push(String(v)); };
  add(m.error); add(m.errorCode); add(m.errorMessage); add(m.meta && m.meta.error); add(m.meta && m.meta.errorCode);
  return [...new Set(parts)].join(' ').trim();
}

const FAILED = new Set(['failed', 'undelivered']);
const OK_OUT = new Set(['delivered', 'read', 'sent']);
const ts = (m) => Date.parse(m.dateAdded || m.createdAt || 0) || 0;

// messages: every SMS in the window (any direction/status). Returns one row per contact: their latest
// failed text, unless they were reached (a later successful text) or replied after it.
function pickFailed(messages) {
  const byContact = new Map();
  for (const m of messages) {
    if (!m || !m.contactId) continue;
    const c = byContact.get(m.contactId) || { failed: null, failedCount: 0, lastOk: 0, lastIn: 0 };
    const t = ts(m);
    if (m.direction === 'inbound') c.lastIn = Math.max(c.lastIn, t);
    else if (FAILED.has(String(m.status || '').toLowerCase())) { c.failedCount++; if (!c.failed || t > ts(c.failed)) c.failed = m; }
    else if (OK_OUT.has(String(m.status || '').toLowerCase())) c.lastOk = Math.max(c.lastOk, t);
    byContact.set(m.contactId, c);
  }
  const rows = []; let reached = 0, replied = 0;
  for (const [contactId, c] of byContact) {
    if (!c.failed) continue;
    const t = ts(c.failed);
    if (c.lastIn > t) { replied++; continue; }
    if (c.lastOk > t) { reached++; continue; }
    const err = errText(c.failed);
    const k = classify(err);
    rows.push({
      contactId, messageId: c.failed.id, conversationId: c.failed.conversationId || null,
      body: c.failed.body || '', attachments: Array.isArray(c.failed.attachments) ? c.failed.attachments.filter((a) => typeof a === 'string').slice(0, 5) : [],
      from: c.failed.from || null, to: c.failed.to || null, ts: t, status: c.failed.status, error: err.slice(0, 300),
      failedCount: c.failedCount, ...k,
    });
  }
  rows.sort((a, b) => b.ts - a.ts);
  return { rows, reached, replied };
}


// Pull every SMS in the window with the message export (cursor paging, newest first), then pick.
// ghl(method, pathAndQuery, version) is injected so this runs against a fake in tests.
const EXPORT_VERSION = process.env.GHL_EXPORT_VERSION || 'v3';
const MAX_MESSAGES = 200000;
async function scanFailed(job, ghl, { locationId, from, to }) {
  const all = [];
  let cursor = null;
  for (let page = 0; page < 400; page++) {
    const qs = new URLSearchParams({ locationId, channel: 'SMS', limit: '1000', sortBy: 'createdAt', sortOrder: 'desc', startDate: new Date(from).toISOString(), endDate: new Date(to).toISOString() });
    if (cursor) qs.set('cursor', cursor);
    const d = await ghl('GET', `/conversations/messages/export?${qs}`, EXPORT_VERSION);
    const list = d.messages || d.data || [];
    for (const m of list) all.push(m);
    job.scanned = all.length;
    cursor = d.nextCursor || d.cursor || null;
    if (!list.length || !cursor || all.length >= MAX_MESSAGES) break;
  }
  job.truncated = all.length >= MAX_MESSAGES;
  const { rows, reached, replied } = pickFailed(all);
  job.rows = rows; job.reached = reached; job.replied = replied;
  job.failedTotal = all.filter((m) => m.direction !== 'inbound' && FAILED.has(String(m.status || '').toLowerCase())).length;
}

// Resend one text per row, one at a time (about 2 a second), from the number it was first sent from.
const RESEND_GAP_MS = Number(process.env.RESEND_GAP_MS || 500);
async function resendAll(job, ghl, rows, version, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  for (const r of rows) {
    if (job.stop) { job.status = 'stopped'; return; }
    const body = { type: 'SMS', contactId: r.contactId, message: r.body };
    if (r.from) body.fromNumber = r.from;
    if (r.attachments?.length) body.attachments = r.attachments;
    try {
      const d = await ghl('POST', '/conversations/messages', version, body);
      r.resent = { ok: true, at: Date.now(), messageId: d.messageId || d.msg?.id || null };
      job.sent++;
    } catch (err) {
      if (err.status === 401 || err.status === 403) { job.status = 'error'; job.error = 'reconnect'; r.resent = { ok: false, error: 'No permission to send' }; return; }
      r.resent = { ok: false, at: Date.now(), error: String(err.message || err).replace(/^GHL returned \d+: /, '').slice(0, 200) };
      job.failed++;
    }
    job.done++;
    await sleep(RESEND_GAP_MS);
  }
  job.status = 'done';
}

module.exports = { errText, classify, pickFailed, scanFailed, resendAll, RETRY, NO_RETRY };
