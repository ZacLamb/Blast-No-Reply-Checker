// Multi-Number SMS: phone clean-up, which numbers get texted, DND, merge fields, webhook parsing.
const test = require('node:test');
const assert = require('node:assert');
const m = require('../multi-sms');

test('e164: US formats, international, junk', () => {
  assert.strictEqual(m.e164('(508) 555-1234'), '+15085551234');
  assert.strictEqual(m.e164('1-508-555-1234'), '+15085551234');
  assert.strictEqual(m.e164('+44 7700 900123'), '+447700900123');
  assert.strictEqual(m.e164('508-555-1234 ext 12'), '+15085551234');
  assert.strictEqual(m.e164('555-1234'), null);
  assert.strictEqual(m.e164('(123) 555-1234'), null);   // area code can't start with 1
  assert.strictEqual(m.e164(''), null);
});

test('numbers per mode, deduped, primary first, invalid dropped', () => {
  const c = { phone: '5085551234', additionalPhones: [{ phone: '+1 (508) 555-1234' }, '617-555-0000', { phone: 'n/a' }, { phone: '7745550001' }] };
  assert.deepStrictEqual(m.numbersFor(c, 'primary'), ['+15085551234']);
  assert.deepStrictEqual(m.numbersFor(c, 'additional'), ['+16175550000', '+17745550001']);
  assert.deepStrictEqual(m.numbersFor(c, 'all'), ['+15085551234', '+16175550000', '+17745550001']);
  assert.deepStrictEqual(m.numbersFor({ additionalPhones: ['6175550000'] }, 'all'), ['+16175550000']);
});

test('DND skips the whole contact', () => {
  assert.ok(m.onDnd({ dnd: true }));
  assert.ok(m.onDnd({ dndSettings: { SMS: { status: 'active' } } }));
  assert.ok(m.onDnd({ tags: ['STOP'] }));
  assert.strictEqual(m.onDnd({ dndSettings: { SMS: { status: 'inactive' } }, tags: ['lead'] }), null);
});

test('merge fields: standard, custom, unknown', () => {
  const c = { firstName: 'Mike', companyName: 'Acme', customFields: [{ id: 'f1', value: '25,000' }] };
  assert.strictEqual(m.render('Hi {{contact.first_name}} at {{ contact.company_name }}, ${{contact.amount}} {{contact.nope}}!', c, { f1: 'amount' }), 'Hi Mike at Acme, $25,000 !');
});

test('webhook body: custom body, standard payload, customData, bad mode', () => {
  assert.deepStrictEqual(m.parseHook({ contactId: 'c1', locationId: 'L1', message: 'hi', mode: 'ALL' }), { contactId: 'c1', locationId: 'L1', message: 'hi', mode: 'all' });
  assert.deepStrictEqual(m.parseHook({ contact_id: 'c2', location: { id: 'L2' }, customData: { message: 'yo', mode: 'additional' } }), { contactId: 'c2', locationId: 'L2', message: 'yo', mode: 'additional' });
  assert.strictEqual(m.parseHook({ contactId: 'c', message: 'x' }).mode, 'all');
  assert.strictEqual(m.parseHook({ contactId: 'c', message: 'x', mode: 'everyone' }).mode, null);
});

test('cleanSearch: keeps the filter and search text only', () => {
  const f = [{ group: 'AND', filters: [{ field: 'tags', operator: 'eq', value: ['9-1'] }] }];
  assert.deepStrictEqual(m.cleanSearch({ filters: f, query: ' bob ', page: 3, locationId: 'x', sort: [] }), { filters: f, query: 'bob' });
  assert.deepStrictEqual(m.cleanSearch({}), { filters: [] });
  assert.strictEqual(m.cleanSearch({ filters: [{ v: 'x'.repeat(30000) }] }), null);
});

// A pretend Postgres that answers only the statements queueBulk/expand use.
function fakeDb() {
  const db = { batches: [], requests: [], hooks: [{ key: 'k1', owner: '7', location_id: 'LOC1', live: false }] };
  db.pool = { async query(sql, p = []) {
    if (/FROM msms_hooks WHERE owner/.test(sql)) return { rows: db.hooks.filter((h) => h.owner === p[0] && h.location_id === p[1]) };
    if (/INSERT INTO msms_batches/.test(sql)) {
      const b = { id: db.batches.length + 1, owner: p[0], location_id: p[1], source: p[2], search: p[3], message: p[4], mode: p[5], from_number: p[6], live: p[7], status: p[8], expected: p[9], found: p[10], cursor: null };
      db.batches.push(b); return { rows: [{ id: b.id }] };
    }
    if (/INSERT INTO msms_requests/.test(sql)) { for (const id of p[3]) db.requests.push({ contact_id: id, from_number: p[7], batch_id: p[8], mode: p[5] }); return { rows: [] }; }
    if (/SELECT id FROM msms_batches WHERE status='expanding'/.test(sql)) return { rows: db.batches.filter((b) => b.status === 'expanding') };
    if (/SELECT \* FROM msms_batches WHERE id/.test(sql)) return { rows: db.batches.filter((b) => b.id === p[0]) };
    if (/UPDATE msms_batches SET found/.test(sql)) { Object.assign(db.batches.find((b) => b.id === p[0]), { found: p[1], cursor: p[2], status: p[3], note: p[4] }); return { rows: [] }; }
    if (/UPDATE msms_batches SET status='failed'/.test(sql)) { Object.assign(db.batches.find((b) => b.id === p[0]), { status: 'failed', note: p[1] }); return { rows: [] }; }
    return { rows: [] };   // tick() lookups etc.
  } };
  return db;
}

test('queueBulk: ticked contacts are queued at once, with the From number', async () => {
  const db = fakeDb();
  const ms = m.create({ pool: db.pool, ghl: async () => ({}), hub: {}, log: { error() {} } });
  const r = await ms.queueBulk('7', 'LOC1', { contactIds: ['a1', 'b2', 'a1', 'bad id!'], message: 'Hi', mode: 'additional', fromNumber: '(617) 944-2522' });
  assert.deepStrictEqual(r, { batchId: 1, live: false, queued: 2, expanding: false });
  assert.deepStrictEqual(db.requests.map((x) => x.contact_id), ['a1', 'b2']);
  assert.strictEqual(db.requests[0].from_number, '+16179442522');
  assert.strictEqual(db.requests[0].mode, 'additional');
  await assert.rejects(ms.queueBulk('7', 'LOC1', { contactIds: [], message: 'Hi' }), /No contacts selected/);
  await assert.rejects(ms.queueBulk('7', 'LOC1', { contactIds: ['a1'], message: '  ' }), /Write a message/);
});

test('Select all: the list filter is paged through with searchAfter until the end', async () => {
  const db = fakeDb();
  const all = Array.from({ length: 1203 }, (_, i) => ({ id: `c${i}`, dateAdded: new Date(2026, 0, 1, 0, 0, 1203 - i).toISOString() }));
  const calls = [];
  const ghl = async (token, method, path, version, body) => {
    calls.push(body);
    const start = body.searchAfter ? all.findIndex((c) => c.id === body.searchAfter[1]) + 1 : 0;
    return { contacts: all.slice(start, start + body.pageLimit), total: all.length };
  };
  const hub = { credentialsFor: async () => ({ pit: 't' }) };
  const ms = m.create({ pool: db.pool, ghl, hub, log: { error() {} } });
  const f = [{ group: 'AND', filters: [{ field: 'tags', operator: 'eq', value: ['9-1'] }] }];
  const r = await ms.queueBulk('7', 'LOC1', { search: { filters: f, query: 'z' }, message: 'Hi', expected: 1203 });
  assert.strictEqual(r.expanding, true);
  for (let i = 0; i < 50 && db.batches[0].status === 'expanding'; i++) await new Promise((res) => setTimeout(res, 20));
  assert.strictEqual(db.batches[0].status, 'queued');
  assert.strictEqual(db.batches[0].found, 1203);
  assert.strictEqual(new Set(db.requests.map((x) => x.contact_id)).size, 1203);
  assert.strictEqual(calls.length, 3);
  assert.deepStrictEqual(calls[0].filters, f);
  assert.strictEqual(calls[0].query, 'z');
  assert.strictEqual(calls[1].searchAfter[1], 'c499');
  await assert.rejects(ms.queueBulk('7', 'LOC1', { search: { filters: f }, message: 'Hi', expected: 10_000_000 }), /most one send can take/);
});
