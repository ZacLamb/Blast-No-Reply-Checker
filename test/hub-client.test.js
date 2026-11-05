// Inside HighLevel: the hub's embed token signs the user in for this tool and one sub-account only.
const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

process.env.HUB_URL = 'https://hub.test'; process.env.HUB_JWT_SECRET = 'sekret'; process.env.HUB_SERVICE_KEY = 'svc';
global.fetch = async (url) => {
  if (String(url).endsWith('/internal/users/7')) return new Response(JSON.stringify({ user: { id: 7, email: 'a@x.com', is_admin: false }, tools: ['blast-tools'], connections: [{ location_id: 'LOC1', label: 'Acme' }, { location_id: 'LOC2', label: 'Other' }] }), { status: 200 });
  return new Response('{}', { status: 404 });
};
const hub = require('../hub-client')({ toolSlug: 'blast-tools' });
const reqWith = (auth) => ({ cookies: {}, get: (h) => (h.toLowerCase() === 'authorization' ? auth : ''), protocol: 'https', originalUrl: '/api/x' });
const run = (req) => new Promise((resolve) => {
  const res = { status(c) { this.c = c; return this; }, json(b) { resolve({ status: this.c, body: b }); } };
  hub.requireTool(req, res, () => resolve({ status: 200 }));
});
const embed = (claims, secret = 'sekret:embed') => 'Bearer ' + jwt.sign(claims, secret, { issuer: 'rgs-embed', expiresIn: '1h' });

test('an embed token for this tool sees only its own sub-account', async () => {
  const req = reqWith(embed({ uid: 7, loc: 'LOC1', tool: 'blast-tools' }));
  assert.strictEqual((await run(req)).status, 200);
  assert.deepStrictEqual(req.hubUser.connections.map((c) => c.location_id), ['LOC1']);
  assert.strictEqual(req.hubUser.embedded, true);
  await assert.rejects(hub.credentials(req, 'LOC2'), /not connected/);
});

test('wrong tool, wrong secret or a sub-account the user does not have are refused', async () => {
  assert.strictEqual((await run(reqWith(embed({ uid: 7, loc: 'LOC1', tool: 'field-finder' })))).status, 401);
  assert.strictEqual((await run(reqWith(embed({ uid: 7, loc: 'LOC1', tool: 'blast-tools' }, 'other:embed')))).status, 401);
  assert.strictEqual((await run(reqWith(embed({ uid: 7, loc: 'LOC9', tool: 'blast-tools' })))).status, 401);
});

test('a normal hub session still works', async () => {
  const req = reqWith('Bearer ' + jwt.sign({ uid: 7 }, 'sekret', { issuer: 'rgs-hub' }));
  assert.strictEqual((await run(req)).status, 200);
  assert.strictEqual(req.hubUser.connections.length, 2);
});
