// Per-sub-account GHL API usage, for Backup & Insights › Usage › API usage.
// Drop this file into each tool next to hub-client.js (the vault uses it as ghl-usage.cjs).
//
//   const apiUsage = require('./ghl-usage')({ tool: 'blast-tools' });
//   apiUsage.bindHub(hub);                       // every token the hub hands out is mapped to its sub-account
//   const res = await fetch(GHL + path, ...);
//   apiUsage.record(res, { token });             // or { locationId } when you have it
//
// HighLevel puts the authoritative numbers on every response (X-RateLimit-Limit-Daily,
// X-RateLimit-Daily-Remaining, X-RateLimit-Max, X-RateLimit-Remaining). We keep the latest
// daily reading and the lowest burst reading per sub-account per hour, count calls per tool,
// and send it all to the hub every 60 s and on shutdown. Reporting is fire-and-forget:
// record() never throws and never waits, a failed send is retried on the next flush,
// and nothing here ever sees a log line with a token in it.
//
// Env (all optional): HUB_URL + HUB_SERVICE_KEY (already set on every tool) turn it on;
// API_USAGE_REPORTING=off turns it off; API_USAGE_FLUSH_MS changes the 60 s interval.
'use strict';
const crypto = require('crypto');

const HEADERS = {
  dailyLimit: 'x-ratelimit-limit-daily',
  dailyRemaining: 'x-ratelimit-daily-remaining',
  intervalMs: 'x-ratelimit-interval-milliseconds',
  burstMax: 'x-ratelimit-max',
  burstRemaining: 'x-ratelimit-remaining',
};
const HOUR = 3600_000;
const CHUNK = 150;           // entries per POST; keeps each body well under the hub's 64 kb JSON limit
const MAX_BUCKETS = 20_000;  // memory cap if the hub is unreachable for a long time
const MAX_TOKENS = 10_000;

// fetch Headers, axios headers (AxiosHeaders or a plain lower-cased object) or a plain object.
function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') {
    const v = headers.get(name);
    if (v !== undefined && v !== null) return v;
  }
  if (typeof headers === 'object') {
    if (headers[name] !== undefined) return headers[name];
    const k = Object.keys(headers).find((x) => x.toLowerCase() === name);
    if (k) return headers[k];
  }
  return undefined;
}
function toInt(v) {
  if (Array.isArray(v)) v = v[0];
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).split(',')[0].trim());
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}
function parseRateHeaders(headers) {
  const out = {};
  for (const [k, h] of Object.entries(HEADERS)) out[k] = toInt(headerValue(headers, h));
  return out;
}

const tokenKey = (token) => crypto.createHash('sha256').update(String(token)).digest('base64url').slice(0, 32);

// Pure in-memory aggregation. send(batch) is async and may throw; the clock is injectable for tests.
function createCollector({ tool, send, now = () => Date.now(), maxBuckets = MAX_BUCKETS }) {
  const buckets = new Map(); // `${locationId}|${hourStart}` -> entry
  const tokens = new Map();  // sha256(token) -> locationId (tokens themselves are never kept here)

  function bind(token, locationId) {
    if (!token || !locationId) return;
    const k = tokenKey(token);
    tokens.delete(k);
    tokens.set(k, String(locationId));
    if (tokens.size > MAX_TOKENS) tokens.delete(tokens.keys().next().value);
  }

  function bucketFor(locationId, at, t = tool) {
    const hour = at - (at % HOUR);
    const key = `${locationId}|${t}|${hour}`;
    let e = buckets.get(key);
    if (!e) {
      e = { locationId, tool: t, hour, calls: 0, errors429: 0, dailyLimit: null, dailyRemaining: null, dailyAt: 0, burstMax: null, burstMinRemaining: null, lastAt: 0 };
      buckets.set(key, e);
      while (buckets.size > maxBuckets) buckets.delete(buckets.keys().next().value);
    }
    return e;
  }

  // Merge a reading (or a requeued entry) into its bucket. Counters add, the daily reading keeps the
  // latest, the burst reading keeps the lowest remaining.
  function merge(e, r) {
    e.calls += r.calls || 0;
    e.errors429 += r.errors429 || 0;
    if (r.dailyLimit !== null && r.dailyRemaining !== null && r.dailyAt >= e.dailyAt) {
      e.dailyLimit = r.dailyLimit; e.dailyRemaining = r.dailyRemaining; e.dailyAt = r.dailyAt;
    }
    if (r.burstMinRemaining !== null && (e.burstMinRemaining === null || r.burstMinRemaining < e.burstMinRemaining)) e.burstMinRemaining = r.burstMinRemaining;
    if (r.burstMax !== null) e.burstMax = r.burstMax;
    if (r.lastAt > e.lastAt) e.lastAt = r.lastAt;
  }

  // res: a fetch Response, an axios response, or { status, headers }. Never throws.
  // opts.tool overrides the collector's tool name for this call (the hub counts 'hub' and 'power-ups').
  function record(res, { locationId, token, tool: t } = {}) {
    try {
      const loc = locationId || (token ? tokens.get(tokenKey(token)) : null);
      if (!loc || !res) return false;
      const status = Number(res.status ?? res.statusCode) || 0;
      const h = parseRateHeaders(res.headers);
      const at = now();
      merge(bucketFor(String(loc), at, t || tool), {
        calls: 1, errors429: status === 429 ? 1 : 0,
        dailyLimit: h.dailyLimit, dailyRemaining: h.dailyLimit !== null ? h.dailyRemaining : null, dailyAt: at,
        burstMax: h.burstMax, burstMinRemaining: h.burstRemaining, lastAt: at,
      });
      return true;
    } catch { return false; }
  }

  // Take everything collected so far, as the hub's batch shape.
  function drain() {
    const out = [];
    for (const e of buckets.values()) {
      out.push({
        locationId: e.locationId, tool: e.tool, calls: e.calls, errors429: e.errors429,
        dailyLimit: e.dailyLimit, dailyRemaining: e.dailyRemaining,
        burstMax: e.burstMax, burstMinRemaining: e.burstMinRemaining,
        // The daily reading's own time when there is one (the hub keeps the latest reading of the day);
        // otherwise the bucket's last call. Either way it falls inside the bucket's hour.
        observedAt: new Date(e.dailyRemaining !== null ? e.dailyAt : e.lastAt || e.hour).toISOString(),
      });
    }
    buckets.clear();
    return out;
  }

  function requeue(batch) {
    for (const b of batch) {
      const at = Date.parse(b.observedAt) || now();
      merge(bucketFor(b.locationId, at, b.tool), {
        calls: b.calls, errors429: b.errors429, dailyLimit: b.dailyLimit, dailyRemaining: b.dailyRemaining, dailyAt: b.dailyRemaining !== null ? at : 0,
        burstMax: b.burstMax, burstMinRemaining: b.burstMinRemaining, lastAt: at,
      });
    }
  }

  let flushing = null;
  function flush() {
    if (flushing) return flushing;
    const batch = drain();
    if (!batch.length || !send) return Promise.resolve(0);
    flushing = (async () => {
      let sent = 0;
      for (let i = 0; i < batch.length; i += CHUNK) {
        const part = batch.slice(i, i + CHUNK);
        try { await send(part); sent += part.length; } catch { requeue(batch.slice(i)); break; }
      }
      return sent;
    })().finally(() => { flushing = null; });
    return flushing;
  }

  return { record, bind, drain, flush, requeue, size: () => buckets.size };
}

function hubSender(hubUrl, serviceKey) {
  const url = `${String(hubUrl).replace(/\/$/, '')}/internal/api-usage`;
  return async (batch) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-service-key': serviceKey },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`hub api-usage ${r.status}`);
  };
}

const NOOP = { record: () => false, bind() {}, bindHub: (h) => h, flush: () => Promise.resolve(0), drain: () => [], size: () => 0, enabled: false };

// One collector per process. Options: tool (required), send (default: POST to the hub), intervalMs.
function ghlUsage({ tool, send, intervalMs, hubUrl = process.env.HUB_URL, serviceKey = process.env.HUB_SERVICE_KEY } = {}) {
  if (/^(off|false|0|no)$/i.test(String(process.env.API_USAGE_REPORTING || ''))) return NOOP;
  if (!send && (!hubUrl || !serviceKey)) return NOOP;
  const c = createCollector({ tool, send: send || hubSender(hubUrl, serviceKey) });
  const every = Number(intervalMs || process.env.API_USAGE_FLUSH_MS) || 60_000;
  setInterval(() => { c.flush().catch(() => {}); }, every).unref();

  // Last flush on shutdown (Railway sends SIGTERM on redeploy). If nothing else handles the signal,
  // re-raise it afterwards so the process still exits the way it would have without us.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => {
      const done = () => { if (!process.listenerCount(sig)) process.kill(process.pid, sig); };
      Promise.race([c.flush().catch(() => {}), new Promise((r) => setTimeout(r, 3000).unref())]).then(done, done);
    });
  }

  // Wrap hub.credentials / hub.credentialsFor so every token handed out is mapped to its sub-account.
  function bindHub(hub) {
    for (const k of ['credentials', 'credentialsFor']) {
      const orig = hub && hub[k];
      if (typeof orig !== 'function') continue;
      hub[k] = async (...args) => {
        const cred = await orig(...args);
        try { if (cred && cred.pit && cred.locationId) c.bind(cred.pit, cred.locationId); } catch { /* never break a request */ }
        return cred;
      };
    }
    return hub;
  }

  return { ...c, bindHub, enabled: true };
}

module.exports = ghlUsage;
module.exports.createCollector = createCollector;
module.exports.parseRateHeaders = parseRateHeaders;
