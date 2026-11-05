// Drop this file into each tool (e.g. src/hub-client.js). Zero dependencies beyond
// jsonwebtoken + cookie-parser, which every tool already has or can add.
//
//   const hub = require('./hub-client')({ toolSlug: 'blast-tools' });
//   app.use(cookieParser());
//   app.use('/api', hub.requireTool);          // 401/402 as JSON for API routes
//   app.get('/', hub.requireToolPage, ...);    // redirects to hub login for pages
//   const { pit, locationId } = await hub.credentials(req, req.query.locationId);
//
// Env vars the tool needs:
//   HUB_URL            https://app.revenuegeneratingsolutions.com   (login redirects)
//   HUB_JWT_SECRET     same value as the hub's JWT_SECRET
//   HUB_SERVICE_KEY    same value as the hub's HUB_SERVICE_KEY
//   HUB_COOKIE_NAME    optional, default rgs_session

const jwt = require('jsonwebtoken');

module.exports = function hubClient({ toolSlug }) {
  const HUB_URL = (process.env.HUB_URL || '').replace(/\/$/, '');
  const SECRET = process.env.HUB_JWT_SECRET;
  const SERVICE_KEY = process.env.HUB_SERVICE_KEY;
  const COOKIE = process.env.HUB_COOKIE_NAME || 'rgs_session';
  if (!HUB_URL || !SECRET || !SERVICE_KEY) throw new Error('HUB_URL, HUB_JWT_SECRET and HUB_SERVICE_KEY are required');

  const cache = new Map(); // key → { value, exp }
  const TTL = 60 * 1000;
  const get = (k) => { const e = cache.get(k); return e && e.exp > Date.now() ? e.value : null; };
  const set = (k, v, ttl = TTL) => cache.set(k, { value: v, exp: Date.now() + ttl });

  async function hubGet(p) {
    const r = await fetch(`${HUB_URL}${p}`, { headers: { 'x-hub-service-key': SERVICE_KEY }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) { const e = new Error(`hub ${p} → ${r.status}`); e.status = r.status; throw e; }
    return r.json();
  }

  // "Inside HighLevel": the tool opened from a sub-account's menu (RGS dashboard > Inside HighLevel). The hub
  // hands it a short-lived token for this tool and one sub-account. The page sends it as a Bearer header, and
  // POST /embed/session also sets it as a partitioned cookie so page links and downloads inside the frame work.
  const EMBED_COOKIE = 'rgs_embed';
  function embedClaims(raw) {
    try {
      const p = jwt.verify(raw, `${SECRET}:embed`, { issuer: 'rgs-embed' });
      return p.tool === toolSlug && p.loc ? { uid: p.uid, embedLoc: p.loc } : null;
    } catch { return null; }
  }
  function sessionFrom(req) {
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const raw = req.cookies?.[COOKIE] || bearer;
    if (raw) { try { return jwt.verify(raw, SECRET, { issuer: 'rgs-hub' }); } catch { /* not a hub session */ } }
    return (bearer && embedClaims(bearer)) || (req.cookies?.[EMBED_COOKIE] && embedClaims(req.cookies[EMBED_COOKIE])) || null;
  }
  function embedSession(req, res) {
    const raw = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!embedClaims(raw)) return res.status(401).json({ error: 'expired' });
    res.append('Set-Cookie', `${EMBED_COOKIE}=${raw}; Path=/; Max-Age=7200; HttpOnly; Secure; SameSite=None; Partitioned`);
    res.json({ ok: true });
  }
  const EXPIRED_PAGE = '<!doctype html><meta charset="utf-8"><p style="font:15px system-ui,sans-serif;color:#6B7280;text-align:center;padding:48px 20px">This page has expired. Close it and open the tool again from the menu.</p>';

  // Entitlements + connections for the user; cached a minute.
  async function profile(userId) {
    const k = `u:${userId}`;
    const hit = get(k); if (hit) return hit;
    const p = await hubGet(`/internal/users/${userId}`);
    set(k, p); return p;
  }

  async function resolve(req) {
    const s = sessionFrom(req);
    if (!s) return { status: 401 };
    let p;
    try { p = await profile(s.uid); } catch (e) { if (e.status === 404) return { status: 401 }; throw e; } // account deleted
    req.hubUser = { id: p.user.id, email: p.user.email, isAdmin: p.user.is_admin, tools: p.tools, connections: p.connections };
    if (s.embedLoc) { // inside HighLevel: only the sub-account it was opened from
      req.hubUser.embedded = true;
      req.hubUser.connections = p.connections.filter((c) => c.location_id === s.embedLoc);
      if (!req.hubUser.connections.length) return { status: 401 };
    }
    if (!p.tools.includes(toolSlug) && !p.user.is_admin) return { status: 402 };
    return { status: 200 };
  }

  // The hub being down or slow must answer the request, not leave it hanging or crash the tool.
  const HUB_DOWN = 'Could not reach RGS Tools to check your account. Please try again in a minute.';
  const hubDown = (e) => console.error(`[hub-client] ${e.message}`);

  const loginUrl = (req) => `${HUB_URL}/login?return=${encodeURIComponent(`${req.protocol}://${req.get('host')}${req.originalUrl}`)}`;

  async function requireTool(req, res, next) {
    try {
      const { status } = await resolve(req);
      if (status === 401) return res.status(401).json({ error: 'not_logged_in', login: loginUrl(req) });
      if (status === 402) return res.status(402).json({ error: 'not_subscribed', subscribe: `${HUB_URL}/app?tool=${toolSlug}` });
    } catch (e) { hubDown(e); return res.status(502).json({ error: HUB_DOWN }); }
    next();
  }

  async function requireToolPage(req, res, next) {
    try {
      const { status } = await resolve(req);
      if (status === 401 && req.get('sec-fetch-dest') === 'iframe') return res.status(401).type('html').send(EXPIRED_PAGE);
      if (status === 401) return res.redirect(loginUrl(req));
      if (status === 402) return res.redirect(`${HUB_URL}/app?tool=${toolSlug}`);
    } catch (e) { hubDown(e); return res.status(502).type('text').send(HUB_DOWN); }
    next();
  }

  // Pick the connection: explicit locationId must belong to the user; otherwise the only one.
  function pickConnection(req, locationId) {
    const conns = req.hubUser?.connections || [];
    if (locationId) return conns.find((c) => c.location_id === locationId) || null;
    return conns.length === 1 ? conns[0] : null;
  }

  // Returns { pit, locationId, label } for a request's user. Throws with .status on failure.
  async function credentials(req, locationId) {
    const c = pickConnection(req, locationId);
    if (!c) { const e = new Error(locationId ? 'That location is not connected to your account.' : 'Pick a location.'); e.status = 400; throw e; }
    const k = `cred:${req.hubUser.id}:${c.location_id}`;
    const hit = get(k); if (hit) return hit;
    const cred = await hubGet(`/internal/users/${req.hubUser.id}/credentials/${encodeURIComponent(c.location_id)}`);
    set(k, cred, 5 * 60 * 1000); return cred;
  }

  // For schedulers: credentials with no request in hand.
  async function credentialsFor(userId, locationId) {
    return hubGet(`/internal/users/${userId}/credentials/${encodeURIComponent(locationId)}`);
  }

  // For schedulers: every user+connection currently entitled to this tool.
  async function entitledUsers() {
    return (await hubGet(`/internal/entitled/${toolSlug}`)).users;
  }

  async function reportTokenError(userId, locationId, error) {
    await fetch(`${HUB_URL}/internal/connections/${userId}/${encodeURIComponent(locationId)}/error`, {
      method: 'POST', headers: { 'x-hub-service-key': SERVICE_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ error }), signal: AbortSignal.timeout(8000),
    }).catch(() => {});
  }

  // Small JSON for the tool's UI: who am I, what locations can I pick.
  function me(req, res) {
    const u = req.hubUser;
    res.json({ email: u.email, connections: u.connections.map(({ location_id, label }) => ({ locationId: location_id, label })), hubUrl: HUB_URL });
  }

  return { requireTool, requireToolPage, embedSession, credentials, credentialsFor, entitledUsers, reportTokenError, me, HUB_URL };
};
