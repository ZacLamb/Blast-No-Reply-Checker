const test = require('node:test');
const assert = require('node:assert');
const { classify, pickFailed, scanFailed, resendAll } = require('../failed-sends');

const T = (h) => new Date(Date.UTC(2026, 9, 20, h)).toISOString();

test('classify sorts carrier errors', () => {
  assert.equal(classify('30003: Unreachable destination handset').verdict, 'retry');
  assert.equal(classify('Error 30007 carrier violation').verdict, 'skip');
  assert.equal(classify('21610 Attempt to send to unsubscribed recipient').verdict, 'skip');
  assert.equal(classify('The number is a landline').verdict, 'skip');
  assert.equal(classify('Contact has unsubscribed').verdict, 'skip');
  assert.equal(classify('').verdict, 'check');
  assert.equal(classify('weird thing happened').verdict, 'check');
  assert.equal(classify('Message stopped by nonstop queue').verdict, 'check'); // "stop" only as a whole word
});

test('pickFailed keeps the latest failure per contact and drops reached / replied', () => {
  const msgs = [
    { id: 'a1', contactId: 'A', direction: 'outbound', status: 'failed', error: '30003', body: 'old', dateAdded: T(1) },
    { id: 'a2', contactId: 'A', direction: 'outbound', status: 'undelivered', error: '30008', body: 'new', dateAdded: T(3), from: '+1555', to: '+1666' },
    { id: 'b1', contactId: 'B', direction: 'outbound', status: 'failed', error: '30003', dateAdded: T(1) },
    { id: 'b2', contactId: 'B', direction: 'outbound', status: 'delivered', dateAdded: T(2) },
    { id: 'c1', contactId: 'C', direction: 'outbound', status: 'failed', error: '30003', dateAdded: T(1) },
    { id: 'c2', contactId: 'C', direction: 'inbound', status: 'delivered', dateAdded: T(2) },
    { id: 'd1', contactId: 'D', direction: 'outbound', status: 'delivered', dateAdded: T(1) },
    { id: 'e0', contactId: 'E', direction: 'outbound', status: 'delivered', dateAdded: T(1) },
    { id: 'e1', contactId: 'E', direction: 'outbound', status: 'failed', error: '21614 not a mobile', dateAdded: T(2) },
  ];
  const { rows, reached, replied } = pickFailed(msgs);
  assert.equal(reached, 1); assert.equal(replied, 1);
  assert.deepEqual(rows.map((r) => r.contactId).sort(), ['A', 'E']);
  const a = rows.find((r) => r.contactId === 'A');
  assert.equal(a.messageId, 'a2'); assert.equal(a.body, 'new'); assert.equal(a.failedCount, 2); assert.equal(a.verdict, 'retry'); assert.equal(a.from, '+1555');
  assert.equal(rows.find((r) => r.contactId === 'E').verdict, 'skip');
});

test('scanFailed pages the export with a cursor', async () => {
  const calls = [];
  const pages = { '': { messages: [{ contactId: 'A', direction: 'outbound', status: 'failed', error: '30003', dateAdded: T(1) }], nextCursor: 'x' }, x: { messages: [{ contactId: 'B', direction: 'outbound', status: 'delivered', dateAdded: T(1) }], nextCursor: null } };
  const job = {};
  await scanFailed(job, async (m, p, v) => { calls.push(p); assert.equal(v, 'v3'); const q = new URL('http://x' + p).searchParams; assert.equal(q.get('channel'), 'SMS'); return pages[q.get('cursor') || '']; }, { locationId: 'L', from: Date.now() - 86400000, to: Date.now() });
  assert.equal(calls.length, 2); assert.equal(job.scanned, 2); assert.equal(job.rows.length, 1); assert.equal(job.failedTotal, 1);
});

test('resendAll sends the original text from the same number and records results', async () => {
  const sent = [];
  const rows = [
    { contactId: 'A', body: 'hi', from: '+1555', attachments: ['https://x/img.png'] },
    { contactId: 'B', body: 'yo', from: null, attachments: [] },
  ];
  const job = { done: 0, sent: 0, failed: 0 };
  await resendAll(job, async (m, p, v, b) => { sent.push(b); if (b.contactId === 'B') { const e = new Error('GHL returned 422: bad'); e.status = 422; throw e; } return { messageId: 'm1' }; }, rows, 'ver', async () => {});
  assert.equal(job.status, 'done'); assert.equal(job.sent, 1); assert.equal(job.failed, 1);
  assert.deepEqual(sent[0], { type: 'SMS', contactId: 'A', message: 'hi', fromNumber: '+1555', attachments: ['https://x/img.png'] });
  assert.equal(sent[1].fromNumber, undefined);
  assert.equal(rows[0].resent.ok, true); assert.equal(rows[1].resent.error, 'bad');
});

test('resendAll stops on a permission error', async () => {
  const job = { done: 0, sent: 0, failed: 0 };
  const rows = [{ contactId: 'A', body: 'x', attachments: [] }, { contactId: 'B', body: 'y', attachments: [] }];
  let n = 0;
  await resendAll(job, async () => { n++; const e = new Error('no'); e.status = 403; throw e; }, rows, 'v', async () => {});
  assert.equal(n, 1); assert.equal(job.status, 'error'); assert.equal(job.error, 'reconnect');
});

test('errText reads the reason whatever shape it comes in', () => {
  const { errText } = require('../failed-sends');
  assert.equal(errText({ error: '30003 Unreachable' }), '30003 Unreachable');
  assert.equal(errText({ error: { code: 30007, message: 'Carrier violation' } }), '30007 Carrier violation');
  assert.equal(errText({ errorCode: 21610, errorMessage: 'Unsubscribed' }), '21610 Unsubscribed');
  assert.equal(errText({ meta: { error: 'Landline' } }), 'Landline');
  assert.equal(errText({}), '');
  assert.equal(classify(errText({ error: { code: 30007 } })).verdict, 'skip');
});
