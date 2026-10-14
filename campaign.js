// Offer campaign engine.
// Replaces the four GHL workflows in the client's spec with API calls run by
// this app: initial text per tag, daily follow-ups inside a sending window,
// reply handling (opt-out / replied), opportunity move, owner task.
//
// Everything it needs is pulled from the sub-account: tags, custom fields, SMS
// snippets, texts from recent blasts, pipelines, users, timezone.

const express = require('express');

module.exports = function campaignModule(deps) {
  const { ghl, store, findLastInbound, localClock, runScan, findBlasts, CONVERSATIONS_VERSION, CONTACTS_VERSION } = deps;
  const V = CONTACTS_VERSION;
  const key = (locationId) => `campaign:${locationId}`;
  const running = new Set();
  const MIN_SEND_GAP_MS = 20 * 60 * 60 * 1000; // "wait 1 day" = next calendar day, at least 20h apart

  // ---------- Defaults ----------
  const defaults = () => ({
    enabled: false,
    tags: { real: 'sms-real-offer', estimate: 'sms-estimate-offer', followup: 'sms-followup', optedOut: 'opted-out', replied: 'sms-replied', exhausted: 'sms-exhausted' },
    templates: { real: null, estimate: null, followup: null }, // { source: 'snippet'|'blast'|'text', id?, name?, body }
    cap: 5,                       // follow-ups per contact after the first text
    window: { days: 'weekdays', start: '09:00', end: '19:00' },
    optOutWords: ['n'],
    pipelineId: null, stageId: null, ownerId: null,
    taskMinutes: 5,
    contacts: {},                 // contactId -> state
    log: [],                      // last 200 events
    stats: {},
    lastReplyCheckAt: null,
    lastEnrollAt: null,
  });

  async function load(locationId) {
    const s = await store.get(key(locationId));
    return s ? { ...defaults(), ...s, tags: { ...defaults().tags, ...(s.tags || {}) }, window: { ...defaults().window, ...(s.window || {}) } } : null;
  }
  const save = (c) => store.put({ ...c, locationId: key(c.realLocationId) });

  function logEvent(c, text, extra) {
    c.log = [{ at: Date.now(), text, ...(extra || {}) }, ...(c.log || [])].slice(0, 200);
  }

  // ---------- Pull from GHL ----------

  async function pullSetup(token, locationId) {
    const out = { snippets: [], blastTexts: [], customFields: [], pipelines: [], users: [], timezone: null, tags: [], warnings: [] };
    const attempt = async (name, fn) => { try { await fn(); } catch (e) { out.warnings.push(`${name}: ${e.message}`); } };

    await attempt('Sub-account', async () => {
      const d = await ghl(token, 'GET', `/locations/${encodeURIComponent(locationId)}`, V);
      out.timezone = d.location?.timezone || null;
    });
    await attempt('SMS snippets', async () => {
      const qs = new URLSearchParams({ originId: locationId, type: 'sms', limit: '100', deleted: 'false' });
      const d = await ghl(token, 'GET', `/locations/${encodeURIComponent(locationId)}/templates?${qs}`, V);
      out.snippets = (d.templates || []).map((t) => ({ id: t.id, name: t.name, body: t.template?.body || '' })).filter((t) => t.body);
    });
    await attempt('Custom fields', async () => {
      const d = await ghl(token, 'GET', `/locations/${encodeURIComponent(locationId)}/customFields?model=contact`, V);
      out.customFields = (d.customFields || []).map((f) => ({ id: f.id, name: f.name, key: f.fieldKey || f.key || '' }));
    });
    await attempt('Pipelines', async () => {
      const d = await ghl(token, 'GET', `/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`, V);
      out.pipelines = (d.pipelines || []).map((p) => ({ id: p.id, name: p.name, stages: (p.stages || []).map((s) => ({ id: s.id, name: s.name })) }));
    });
    await attempt('Users', async () => {
      const d = await ghl(token, 'GET', `/users/?locationId=${encodeURIComponent(locationId)}`, V);
      out.users = (d.users || []).map((u) => ({ id: u.id, name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email, email: u.email, phone: u.phone || '' }));
    });
    await attempt('Tags', async () => {
      const d = await ghl(token, 'GET', `/locations/${encodeURIComponent(locationId)}/tags`, V);
      out.tags = (d.tags || []).map((t) => t.name);
    });
    await attempt('Recent blasts', async () => {
      const scan = { status: 'running', scanned: 0, items: [] };
      await runScan(scan, { token, locationId, days: 30 });
      if (scan.status === 'error') throw new Error(scan.error);
      const seen = new Set();
      for (const b of findBlasts(scan.items, 10 * 60000, 20)) {
        if (seen.has(b.sample)) continue;
        seen.add(b.sample);
        out.blastTexts.push({ id: `${b.from}`, sentAt: b.to, count: b.count, body: b.sample });
      }
    });
    return out;
  }

  // ---------- Contacts ----------

  async function contactsWithTag(token, locationId, tag) {
    const found = [];
    let searchAfter = null;
    for (let page = 0; page < 200; page++) {
      const body = { locationId, pageLimit: 100, filters: [{ field: 'tags', operator: 'eq', value: tag }] };
      if (searchAfter) body.searchAfter = searchAfter;
      const d = await ghl(token, 'POST', '/contacts/search', V, body);
      const list = d.contacts || [];
      for (const c of list) found.push(c);
      if (list.length < 100) break;
      const last = list[list.length - 1];
      if (!last.searchAfter) break;
      searchAfter = last.searchAfter;
    }
    return found;
  }

  async function getContact(token, id) {
    const d = await ghl(token, 'GET', `/contacts/${encodeURIComponent(id)}`, V);
    return d.contact || d;
  }

  // {{contact.first_name}}, {{contact.offer_k}} ... filled from the contact record.
  function render(body, contact, fieldsById) {
    const cf = {};
    for (const f of contact.customFields || []) {
      const def = fieldsById.get(f.id);
      const k = (def?.key || '').replace(/^contact\./, '') || f.id;
      cf[k] = f.value ?? f.fieldValue ?? '';
    }
    const base = {
      first_name: contact.firstName || '', last_name: contact.lastName || '', name: contact.name || [contact.firstName, contact.lastName].filter(Boolean).join(' '),
      full_name: contact.name || '', email: contact.email || '', phone: contact.phone || '', company_name: contact.companyName || '',
    };
    return String(body).replace(/\{\{\s*contact\.([a-zA-Z0-9_]+)\s*\}\}/g, (m, k) => (k in base ? base[k] : (k in cf ? cf[k] : '')));
  }

  async function sendSms(token, contactId, message) {
    return ghl(token, 'POST', '/conversations/messages', CONVERSATIONS_VERSION, { type: 'SMS', contactId, message });
  }
  const addTag = (token, id, tag) => ghl(token, 'POST', `/contacts/${encodeURIComponent(id)}/tags`, V, { tags: [tag] });
  const removeTag = (token, id, tag) => ghl(token, 'DELETE', `/contacts/${encodeURIComponent(id)}/tags`, V, { tags: [tag] });

  function inWindow(c, tz) {
    const clock = localClock(tz);
    if (c.window.days === 'weekdays' && (clock.dow === 0 || clock.dow === 6)) return false;
    return clock.hm >= c.window.start && clock.hm < c.window.end;
  }

  function templateBody(c, which) {
    const t = c.templates[which];
    if (!t || !t.body) throw new Error(`No ${which} template chosen.`);
    return t.body;
  }

  // ---------- Engine ----------

  async function enroll(c, token, fieldsById, tz) {
    for (const kind of ['real', 'estimate']) {
      const tag = c.tags[kind];
      let list;
      try { list = await contactsWithTag(token, c.realLocationId, tag); } catch (e) { logEvent(c, `Could not look up contacts tagged ${tag}: ${e.message}`); continue; }
      for (const ct of list) {
        if (c.contacts[ct.id]) continue;
        const tags = (ct.tags || []).map((t) => String(t).toLowerCase());
        if (tags.includes(c.tags.optedOut) || ct.dnd === true) { c.contacts[ct.id] = { kind, status: 'skipped', reason: 'DND or opted out', name: ct.contactName || ct.name || '', startedAt: Date.now() }; continue; }
        const ctz = ct.timezone || tz;
        const st = { kind, status: 'active', name: ct.contactName || ct.name || [ct.firstName, ct.lastName].filter(Boolean).join(' '), phone: ct.phone || '', tz: ctz, startedAt: Date.now(), sends: 0, lastSentAt: null, lastSentDate: null };
        c.contacts[ct.id] = st;
        if (!inWindow(c, ctz)) { st.pendingFirst = true; continue; }
        await sendFirst(c, token, ct.id, st, fieldsById);
      }
    }
  }

  async function sendFirst(c, token, id, st, fieldsById) {
    try {
      const full = await getContact(token, id);
      const msg = render(templateBody(c, st.kind), full, fieldsById);
      await sendSms(token, id, msg);
      await addTag(token, id, c.tags.followup);
      st.sends = 1; st.lastSentAt = Date.now(); st.lastSentDate = localClock(st.tz).date; st.pendingFirst = false;
      logEvent(c, `Sent ${st.kind === 'real' ? 'real offer' : 'estimate'} text to ${st.name || id}`, { contactId: id });
    } catch (e) {
      st.status = 'error'; st.error = e.message;
      logEvent(c, `Could not text ${st.name || id}: ${e.message}`, { contactId: id });
    }
  }

  async function followUps(c, token, fieldsById) {
    const now = Date.now();
    for (const [id, st] of Object.entries(c.contacts)) {
      if (st.status !== 'active') continue;
      if (!inWindow(c, st.tz)) continue;
      if (st.pendingFirst) { await sendFirst(c, token, id, st, fieldsById); continue; }
      const today = localClock(st.tz).date;
      if (st.lastSentDate === today || (st.lastSentAt && now - st.lastSentAt < MIN_SEND_GAP_MS)) continue;
      if (st.sends - 1 >= c.cap) {
        st.status = 'exhausted';
        try { await removeTag(token, id, c.tags.followup); if (c.tags.exhausted) await addTag(token, id, c.tags.exhausted); } catch (e) { /* tag is cosmetic */ }
        logEvent(c, `Stopped after ${c.cap} follow-ups: ${st.name || id}`, { contactId: id });
        continue;
      }
      // Last look before texting again: has anything come in since we started?
      try {
        const conv = await findConversation(token, c.realLocationId, id);
        const inbound = conv ? await findLastInbound(token, conv) : null;
        if (inbound !== null && inbound >= st.startedAt) { await handleReply(c, token, id, st, null, conv); continue; }
        const full = await getContact(token, id);
        if (full.dnd === true || (full.dndSettings && full.dndSettings.SMS && full.dndSettings.SMS.status === 'active')) { st.status = 'opted-out'; logEvent(c, `DND is on, stopped: ${st.name || id}`, { contactId: id }); continue; }
        const msg = render(templateBody(c, 'followup'), full, fieldsById);
        await sendSms(token, id, msg);
        st.sends++; st.lastSentAt = now; st.lastSentDate = today;
        logEvent(c, `Follow-up ${st.sends - 1} of ${c.cap} to ${st.name || id}`, { contactId: id });
      } catch (e) {
        st.lastError = e.message;
        logEvent(c, `Follow-up to ${st.name || id} failed: ${e.message}`, { contactId: id });
      }
    }
  }

  async function findConversation(token, locationId, contactId) {
    const qs = new URLSearchParams({ locationId, contactId, limit: '1' });
    const d = await ghl(token, 'GET', `/conversations/search?${qs}`, CONVERSATIONS_VERSION);
    return d.conversations?.[0]?.id || null;
  }

  // Every conversation with a NEW inbound message since the last check, in a
  // few pages, rather than one call per contact.
  async function replyPass(c, token) {
    const since = c.lastReplyCheckAt || Math.min(...Object.values(c.contacts).map((s) => s.startedAt), Date.now());
    const checkStart = Date.now();
    let cursor = null;
    const seen = new Set();
    for (let page = 0; page < 100; page++) {
      const qs = new URLSearchParams({ locationId: c.realLocationId, limit: '100', sort: 'desc', sortBy: 'last_message_date', lastMessageDirection: 'inbound' });
      if (cursor !== null) qs.set('startAfterDate', String(cursor));
      const d = await ghl(token, 'GET', `/conversations/search?${qs}`, CONVERSATIONS_VERSION);
      const list = d.conversations || [];
      if (!list.length) break;
      let oldest = Infinity, fresh = 0;
      for (const conv of list) {
        const ts = Array.isArray(conv.sort) ? conv.sort[0] : Number(conv.lastMessageDate) || 0;
        if (ts < oldest) oldest = ts;
        if (seen.has(conv.id)) continue;
        seen.add(conv.id); fresh++;
        if (ts < since - 60000) continue;
        const st = c.contacts[conv.contactId];
        if (!st || st.status !== 'active') continue;
        if (ts < st.startedAt) continue;
        await handleReply(c, token, conv.contactId, st, conv.lastMessageBody || '', conv.id);
      }
      if (oldest < since - 60000) break;
      cursor = fresh === 0 ? (cursor === oldest ? null : oldest) : oldest + 1;
      if (cursor === null) break;
    }
    c.lastReplyCheckAt = checkStart;
  }

  async function handleReply(c, token, id, st, bodyHint, conversationId) {
    let body = bodyHint;
    if (body === null || body === undefined) {
      try {
        const d = await ghl(token, 'GET', `/conversations/${encodeURIComponent(conversationId)}/messages?limit=20`, CONVERSATIONS_VERSION);
        const m = (d.messages?.messages || []).find((x) => x.direction === 'inbound' && !String(x.messageType || '').startsWith('TYPE_ACTIVITY'));
        body = m?.body || '';
      } catch { body = ''; }
    }
    const word = String(body).trim().toLowerCase().replace(/[.!]+$/, '');
    const optOut = c.optOutWords.map((w) => w.toLowerCase()).includes(word);
    try {
      if (optOut) {
        await ghl(token, 'PUT', `/contacts/${encodeURIComponent(id)}`, V, { dndSettings: { SMS: { status: 'active', message: 'Replied N' } } });
        await addTag(token, id, c.tags.optedOut);
        await removeTag(token, id, c.tags.followup);
        st.status = 'opted-out'; st.repliedAt = Date.now(); st.reply = body;
        logEvent(c, `Opted out (replied "${body.trim()}"): ${st.name || id}`, { contactId: id });
        return;
      }
      await addTag(token, id, c.tags.replied);
      await removeTag(token, id, c.tags.followup);
      st.status = 'replied'; st.repliedAt = Date.now(); st.reply = body;
      const notes = [];
      if (c.pipelineId && c.stageId) {
        try {
          const qs = new URLSearchParams({ location_id: c.realLocationId, locationId: c.realLocationId, contact_id: id, contactId: id, pipeline_id: c.pipelineId, pipelineId: c.pipelineId });
          const d = await ghl(token, 'GET', `/opportunities/search?${qs}`, V);
          const opp = (d.opportunities || []).find((o) => o.pipelineId === c.pipelineId) || (d.opportunities || [])[0];
          if (opp) { await ghl(token, 'PUT', `/opportunities/${encodeURIComponent(opp.id)}`, V, { pipelineStageId: c.stageId }); notes.push('moved to Contacted'); }
          else notes.push('no opportunity in that pipeline');
        } catch (e) { notes.push(`opportunity not moved: ${e.message}`); }
      }
      if (c.ownerId) {
        try {
          if (st.kind === 'real') { await ghl(token, 'PUT', `/contacts/${encodeURIComponent(id)}`, V, { assignedTo: c.ownerId }); notes.push('assigned'); }
          const due = new Date(Date.now() + (st.kind === 'real' ? c.taskMinutes : 60) * 60000).toISOString();
          await ghl(token, 'POST', `/contacts/${encodeURIComponent(id)}/tasks`, V, {
            title: st.kind === 'real' ? `CALL NOW (${c.taskMinutes} min): ${st.name || 'lead'} replied to real offer` : `Lead replied: ${st.name || id}`,
            body: `Reply: "${String(body).trim()}"`, dueDate: due, completed: false, assignedTo: c.ownerId,
          });
          notes.push('task created');
        } catch (e) { notes.push(`task failed: ${e.message}`); }
      }
      logEvent(c, `Replied "${String(body).trim().slice(0, 60)}": ${st.name || id}` + (notes.length ? ` (${notes.join(', ')})` : ''), { contactId: id });
    } catch (e) {
      st.lastError = e.message;
      logEvent(c, `Reply handling failed for ${st.name || id}: ${e.message}`, { contactId: id });
    }
  }

  function recount(c) {
    const s = { active: 0, replied: 0, 'opted-out': 0, exhausted: 0, error: 0, skipped: 0 };
    for (const st of Object.values(c.contacts)) s[st.status] = (s[st.status] || 0) + 1;
    c.stats = s;
  }

  async function runOnce(c, { force = false } = {}) {
    if (running.has(c.realLocationId)) return;
    running.add(c.realLocationId);
    try {
      const token = c.token;
      const setup = c.setup || {};
      const fieldsById = new Map((setup.customFields || []).map((f) => [f.id, f]));
      const tz = setup.timezone || 'America/New_York';
      await enroll(c, token, fieldsById, tz);
      const now = Date.now();
      if (force || !c.lastReplyCheckAt || now - c.lastReplyCheckAt > 4 * 60000) await replyPass(c, token);
      await followUps(c, token, fieldsById);
      recount(c);
      c.lastRunAt = now; c.lastRunError = null;
    } catch (e) {
      c.lastRunError = e.message;
      logEvent(c, `Run failed: ${e.message}`);
    } finally {
      try { await save(c); } catch (e) { console.error('campaign save failed', e.message); }
      running.delete(c.realLocationId);
    }
  }

  async function tick() {
    let all;
    try { all = (await store.all()).filter((s) => String(s.locationId || '').startsWith('campaign:') && s.enabled); } catch (e) { return console.error('[campaign] list failed', e.message); }
    for (const raw of all) {
      const c = { ...defaults(), ...raw };
      await runOnce(c);
    }
  }

  // ---------- HTTP ----------

  const router = express.Router();

  async function authed(req, res) {
    const token = String(req.body?.token || '').trim();
    const locationId = String(req.body?.locationId || '').trim();
    if (!token || !locationId) { res.status(400).json({ error: 'Location ID and token are both required.' }); return null; }
    try {
      await ghl(token, 'GET', `/conversations/search?${new URLSearchParams({ locationId, limit: '1' })}`, CONVERSATIONS_VERSION);
      return { token, locationId };
    } catch (err) {
      res.status(err.status === 401 || err.status === 403 ? 401 : 502).json({ error: err.message });
      return null;
    }
  }

  function pub(c) {
    if (!c) return null;
    const { token, contacts, log, setup, ...rest } = c;
    const recent = Object.entries(contacts || {}).sort((a, b) => (b[1].lastSentAt || b[1].startedAt) - (a[1].lastSentAt || a[1].startedAt)).slice(0, 50)
      .map(([id, s]) => ({ id, name: s.name, phone: s.phone, kind: s.kind, status: s.status, sends: s.sends, reply: s.reply, error: s.error || s.lastError }));
    return { ...rest, running: running.has(c.realLocationId), log: (log || []).slice(0, 50), recent, total: Object.keys(contacts || {}).length,
      setupSummary: setup ? { timezone: setup.timezone, snippets: setup.snippets?.length || 0, customFields: setup.customFields?.length || 0, pulledAt: setup.pulledAt } : null };
  }

  router.post('/setup', async (req, res) => {
    const a = await authed(req, res); if (!a) return;
    const setup = await pullSetup(a.token, a.locationId);
    setup.pulledAt = Date.now();
    const c = (await load(a.locationId)) || { ...defaults(), realLocationId: a.locationId, createdAt: Date.now() };
    c.token = a.token; c.setup = setup;
    await save(c);
    const want = ['offer_k', 'payback_amount', 'weekly_payment'];
    const keys = setup.customFields.map((f) => f.key.replace(/^contact\./, ''));
    res.json({ setup, campaign: pub(c), missingFields: want.filter((k) => !keys.includes(k)) });
  });

  router.post('/get', async (req, res) => {
    const a = await authed(req, res); if (!a) return;
    const c = await load(a.locationId);
    res.json({ campaign: pub(c), setup: c?.setup || null });
  });

  router.post('/save', async (req, res) => {
    const a = await authed(req, res); if (!a) return;
    const b = req.body || {};
    const c = (await load(a.locationId)) || { ...defaults(), realLocationId: a.locationId, createdAt: Date.now() };
    c.token = a.token;
    const t = b.tags || {};
    for (const k of Object.keys(c.tags)) if (typeof t[k] === 'string' && t[k].trim()) c.tags[k] = t[k].trim().toLowerCase();
    for (const k of ['real', 'estimate', 'followup']) {
      const tp = b.templates?.[k];
      if (tp && typeof tp.body === 'string' && tp.body.trim()) c.templates[k] = { source: tp.source || 'text', id: tp.id || null, name: tp.name || null, body: tp.body };
      else if (tp === null) c.templates[k] = null;
    }
    if (b.cap !== undefined) c.cap = Math.min(60, Math.max(0, Number(b.cap) || 0));
    if (b.window) c.window = { days: b.window.days === 'daily' ? 'daily' : 'weekdays', start: /^\d\d:\d\d$/.test(b.window.start || '') ? b.window.start : c.window.start, end: /^\d\d:\d\d$/.test(b.window.end || '') ? b.window.end : c.window.end };
    if (Array.isArray(b.optOutWords)) c.optOutWords = b.optOutWords.map((w) => String(w).trim().toLowerCase()).filter(Boolean);
    if ('pipelineId' in b) c.pipelineId = b.pipelineId || null;
    if ('stageId' in b) c.stageId = b.stageId || null;
    if ('ownerId' in b) c.ownerId = b.ownerId || null;
    if (b.taskMinutes !== undefined) c.taskMinutes = Math.max(1, Number(b.taskMinutes) || 5);
    if (b.enabled !== undefined) {
      const missing = ['real', 'estimate', 'followup'].filter((k) => !c.templates[k]?.body);
      if (b.enabled && missing.length) return res.status(400).json({ error: `Choose a template for: ${missing.join(', ')}.` });
      c.enabled = !!b.enabled;
      logEvent(c, c.enabled ? 'Campaign turned on' : 'Campaign turned off');
    }
    c.updatedAt = Date.now();
    await save(c);
    res.json({ campaign: pub(c) });
  });

  router.post('/run', async (req, res) => {
    const a = await authed(req, res); if (!a) return;
    const c = await load(a.locationId);
    if (!c) return res.status(404).json({ error: 'Pull the setup and save first.' });
    if (running.has(a.locationId)) return res.status(409).json({ error: 'Already running.' });
    runOnce(c, { force: true });
    res.json({ started: true });
  });

  // Send one rendered template to one contact (found by phone or ID), outside the campaign.
  router.post('/test', async (req, res) => {
    const a = await authed(req, res); if (!a) return;
    const c = await load(a.locationId);
    if (!c) return res.status(404).json({ error: 'Pull the setup first.' });
    const which = ['real', 'estimate', 'followup'].includes(req.body.which) ? req.body.which : 'real';
    const q = String(req.body.contact || '').trim();
    if (!q) return res.status(400).json({ error: 'Enter a phone number or contact ID.' });
    try {
      let contact = null;
      if (/^[A-Za-z0-9]{15,}$/.test(q)) contact = await getContact(a.token, q).catch(() => null);
      if (!contact) {
        const d = await ghl(a.token, 'GET', `/contacts/?${new URLSearchParams({ locationId: a.locationId, query: q, limit: '5' })}`, V);
        contact = (d.contacts || [])[0] || null;
        if (contact) contact = await getContact(a.token, contact.id);
      }
      if (!contact) return res.status(404).json({ error: 'No contact found for that phone or ID.' });
      const body = req.body.body && String(req.body.body).trim() ? String(req.body.body) : templateBody(c, which);
      const fieldsById = new Map((c.setup?.customFields || []).map((f) => [f.id, f]));
      const msg = render(body, contact, fieldsById);
      if (req.body.preview) return res.json({ preview: msg, contact: { id: contact.id, name: contact.name || contact.firstName, phone: contact.phone } });
      await sendSms(a.token, contact.id, msg);
      logEvent(c, `Test "${which}" sent to ${contact.name || contact.phone}`, { contactId: contact.id });
      await save(c);
      res.json({ sent: true, message: msg, contact: { id: contact.id, name: contact.name || contact.firstName, phone: contact.phone } });
    } catch (e) { res.status(e.status === 401 || e.status === 403 ? 401 : 500).json({ error: e.message }); }
  });

  router.post('/delete', async (req, res) => {
    const a = await authed(req, res); if (!a) return;
    await store.remove(key(a.locationId));
    res.json({ ok: true });
  });

  return { router, tick };
};
