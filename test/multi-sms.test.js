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
