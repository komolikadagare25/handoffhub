require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { logger, als } = require('./logger');
const ai = require('./ai');
const { seedIfEmpty } = require('./seed');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------- request id + access log ----------
app.use((req, res, next) => {
  const reqId = (req.headers['x-request-id'] && String(req.headers['x-request-id']).slice(0, 64)) || crypto.randomUUID();
  res.setHeader('x-request-id', reqId);
  als.run({ reqId }, () => {
    const started = Date.now();
    res.on('finish', () => {
      if (req.path.startsWith('/api')) {
        logger.info({ event: 'http_request', method: req.method, path: req.path, status: res.statusCode, latencyMs: Date.now() - started });
      }
    });
    next();
  });
});

// ---------- helpers ----------
class ApiError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
const MEETING_TYPES = ['meeting', 'handoff'];
const MEETING_STATUS = ['draft', 'scheduled', 'completed', 'archived'];
const ITEM_STATUS = ['open', 'in_progress', 'done', 'cancelled'];
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const todayStr = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.floor((Date.parse(b) - Date.parse(a)) / 86400000);

function cleanStr(v, field, { required = false, max = 5000 } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new ApiError(400, `${field} is required`);
    return '';
  }
  if (typeof v !== 'string') throw new ApiError(400, `${field} must be a string`);
  const s = v.trim();
  if (required && !s) throw new ApiError(400, `${field} is required`);
  if (s.length > max) throw new ApiError(400, `${field} is too long (max ${max})`);
  return s;
}
function cleanList(v, field) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ApiError(400, `${field} must be an array`);
  return [...new Set(v.map((x) => String(x).trim()).filter(Boolean))].slice(0, 50);
}
function cleanDate(v, field) {
  if (v === undefined || v === null || v === '') return null;
  if (!isDate(v)) throw new ApiError(400, `${field} must be a valid YYYY-MM-DD date`);
  return v;
}
function parseId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new ApiError(400, 'invalid id');
  return n;
}

const meetingOut = (m) => m && ({ ...m, participants: JSON.parse(m.participants), decisions: JSON.parse(m.decisions), kb_links: JSON.parse(m.kb_links) });
const getMeeting = (id) => {
  const m = meetingOut(db.prepare('SELECT * FROM meetings WHERE id = ?').get(id));
  if (!m) throw new ApiError(404, 'meeting not found');
  return m;
};
const getItem = (id) => {
  const i = db.prepare('SELECT * FROM action_items WHERE id = ?').get(id);
  if (!i) throw new ApiError(404, 'action item not found');
  return i;
};
const logHistory = (itemId, event, detail = '') => {
  db.prepare('INSERT INTO item_history (item_id, event, detail) VALUES (?, ?, ?)').run(itemId, event, detail);
  logger.info({ event: `item_${event}`, itemId, detail });
};
const withOverdue = (i) => ({ ...i, overdue: ['open', 'in_progress'].includes(i.status) && !!i.due_date && i.due_date < todayStr() });
const touchMeeting = (id) => db.prepare("UPDATE meetings SET updated_at = datetime('now') WHERE id = ?").run(id);

function insertItem(meetingId, { title, owner, due_date, source = 'manual', carried_from_id = null }) {
  const info = db.prepare('INSERT INTO action_items (meeting_id, title, owner, due_date, source, carried_from_id) VALUES (?,?,?,?,?,?)')
    .run(meetingId, title, owner || '', due_date || null, source, carried_from_id);
  const id = Number(info.lastInsertRowid);
  logHistory(id, 'created', `title="${title}" owner="${owner || ''}" source=${source}${carried_from_id ? ` carried_from=${carried_from_id}` : ''}`);
  return id;
}

// ---------- health ----------
app.get('/api/health', (req, res) => res.json({ ok: true, ai_configured: !!process.env.GEMINI_API_KEY, time: new Date().toISOString() }));

// ---------- meetings ----------
app.get('/api/meetings', (req, res) => {
  const rows = db.prepare(`
    SELECT m.*,
      (SELECT COUNT(*) FROM action_items a WHERE a.meeting_id = m.id AND a.status IN ('open','in_progress')) AS open_items,
      (SELECT COUNT(*) FROM action_items a WHERE a.meeting_id = m.id) AS total_items
    FROM meetings m ORDER BY m.created_at DESC, m.id DESC`).all();
  res.json(rows.map(meetingOut));
});

app.post('/api/meetings', (req, res) => {
  const b = req.body || {};
  const type = b.type || 'meeting';
  if (!MEETING_TYPES.includes(type)) throw new ApiError(400, `type must be one of ${MEETING_TYPES.join(', ')}`);
  const title = cleanStr(b.title, 'title', { required: true, max: 200 });
  const info = db.prepare('INSERT INTO meetings (title, type, agenda, participants, notes, scheduled_at, prev_meeting_id) VALUES (?,?,?,?,?,?,?)').run(
    title, type, cleanStr(b.agenda, 'agenda'), JSON.stringify(cleanList(b.participants, 'participants')),
    cleanStr(b.notes, 'notes', { max: 50000 }), cleanDate(b.scheduled_at, 'scheduled_at'), b.prev_meeting_id ? parseId(b.prev_meeting_id) : null);
  const id = Number(info.lastInsertRowid);
  logger.info({ event: 'meeting_created', meetingId: id, type, title });
  res.status(201).json(getMeeting(id));
});

app.get('/api/meetings/:id', (req, res) => {
  const id = parseId(req.params.id);
  const meeting = getMeeting(id);
  const items = db.prepare('SELECT * FROM action_items WHERE meeting_id = ? ORDER BY id').all(id).map(withOverdue);
  res.json({ ...meeting, items });
});

app.put('/api/meetings/:id', (req, res) => {
  const id = parseId(req.params.id);
  const cur = getMeeting(id);
  const b = req.body || {};
  const status = b.status ?? cur.status;
  if (!MEETING_STATUS.includes(status)) throw new ApiError(400, `status must be one of ${MEETING_STATUS.join(', ')}`);
  const title = b.title !== undefined ? cleanStr(b.title, 'title', { required: true, max: 200 }) : cur.title;
  db.prepare(`UPDATE meetings SET title=?, status=?, agenda=?, participants=?, notes=?, summary=?, decisions=?, scheduled_at=?, updated_at=datetime('now') WHERE id=?`).run(
    title, status,
    b.agenda !== undefined ? cleanStr(b.agenda, 'agenda') : cur.agenda,
    JSON.stringify(b.participants !== undefined ? cleanList(b.participants, 'participants') : cur.participants),
    b.notes !== undefined ? cleanStr(b.notes, 'notes', { max: 50000 }) : cur.notes,
    b.summary !== undefined ? cleanStr(b.summary, 'summary') : cur.summary,
    JSON.stringify(b.decisions !== undefined ? cleanList(b.decisions, 'decisions') : cur.decisions),
    b.scheduled_at !== undefined ? cleanDate(b.scheduled_at, 'scheduled_at') : cur.scheduled_at, id);
  if (status !== cur.status) logger.info({ event: 'meeting_status_changed', meetingId: id, from: cur.status, to: status });
  res.json(getMeeting(id));
});

app.delete('/api/meetings/:id', (req, res) => {
  const id = parseId(req.params.id);
  getMeeting(id);
  db.prepare('UPDATE meetings SET prev_meeting_id = NULL WHERE prev_meeting_id = ?').run(id);
  db.prepare('DELETE FROM meetings WHERE id = ?').run(id);
  logger.info({ event: 'meeting_deleted', meetingId: id });
  res.status(204).end();
});

// AI: raw notes -> structured recap (summary, decisions, action items + owners)
app.post('/api/meetings/:id/recap', async (req, res) => {
  const id = parseId(req.params.id);
  const m = getMeeting(id);
  const raw = cleanStr(req.body?.notes ?? m.notes, 'notes', { required: true, max: 50000 });
  const recap = await ai.generateRecap(raw, { title: m.title, participants: m.participants });
  const tx = db.transaction(() => {
    db.prepare("UPDATE meetings SET notes=?, summary=?, decisions=?, updated_at=datetime('now') WHERE id=?").run(raw, recap.summary, JSON.stringify(recap.decisions), id);
    return recap.action_items.map((a) => insertItem(id, { ...a, source: recap.ai_used ? 'ai' : 'manual' }));
  });
  const created = tx();
  logger.info({ event: 'recap_applied', meetingId: id, items: created.length, ai_used: recap.ai_used });
  res.json({ ...recap, created_item_ids: created, meeting: getMeeting(id) });
});

// AI: catch-up brief for someone who missed it / is taking over
app.get('/api/meetings/:id/catchup', async (req, res) => {
  const id = parseId(req.params.id);
  const m = getMeeting(id);
  const person = cleanStr(req.query.person, 'person', { max: 100 });
  // follow the chain backwards for context
  const chain = [];
  let cur = m;
  while (cur.prev_meeting_id && chain.length < 3) { cur = getMeeting(cur.prev_meeting_id); chain.push({ title: cur.title, summary: cur.summary, decisions: cur.decisions }); }
  const open_items = db.prepare("SELECT title, owner, due_date, status FROM action_items WHERE meeting_id = ? AND status IN ('open','in_progress')").all(id);
  const brief = await ai.generateCatchup({
    person, meeting: { title: m.title, agenda: m.agenda, summary: m.summary, decisions: m.decisions, participants: m.participants },
    open_items, earlier_meetings: chain, knowledge_base: m.kb_links.map((l) => l.title),
  });
  logger.info({ event: 'catchup_generated', meetingId: id, person, ai_used: brief.ai_used });
  res.json(brief);
});

// Carry open items into the next meeting / work transfer, keeping history
app.post('/api/meetings/:id/carry-forward', (req, res) => {
  const id = parseId(req.params.id);
  const prev = getMeeting(id);
  const b = req.body || {};
  const open = db.prepare("SELECT * FROM action_items WHERE meeting_id = ? AND status IN ('open','in_progress')").all(id);
  const tx = db.transaction(() => {
    const info = db.prepare('INSERT INTO meetings (title, type, agenda, participants, scheduled_at, prev_meeting_id) VALUES (?,?,?,?,?,?)').run(
      cleanStr(b.title, 'title', { max: 200 }) || `${prev.title} (follow-up)`, prev.type,
      `Review ${open.length} carried-over item(s) from "${prev.title}"`, JSON.stringify(prev.participants), cleanDate(b.scheduled_at, 'scheduled_at'), id);
    const newId = Number(info.lastInsertRowid);
    for (const it of open) {
      const nid = insertItem(newId, { title: it.title, owner: it.owner, due_date: it.due_date, carried_from_id: it.id });
      db.prepare("UPDATE action_items SET status='carried', updated_at=datetime('now') WHERE id=?").run(it.id);
      logHistory(it.id, 'carried_forward', `to meeting ${newId} as item ${nid}`);
    }
    db.prepare("UPDATE meetings SET status='completed', updated_at=datetime('now') WHERE id=?").run(id);
    return newId;
  });
  const newId = tx();
  logger.info({ event: 'items_carried_forward', fromMeeting: id, toMeeting: newId, count: open.length });
  res.status(201).json({ meeting: getMeeting(newId), carried: open.length });
});

// AI: link meeting to knowledge-base docs
app.post('/api/meetings/:id/link-kb', async (req, res) => {
  const id = parseId(req.params.id);
  const m = getMeeting(id);
  const docs = db.prepare('SELECT * FROM kb_docs').all();
  const result = await ai.linkKnowledge(m, docs);
  db.prepare("UPDATE meetings SET kb_links=?, updated_at=datetime('now') WHERE id=?").run(JSON.stringify(result.links), id);
  logger.info({ event: 'kb_linked', meetingId: id, links: result.links.length, ai_used: result.ai_used });
  res.json(result);
});

// ---------- action items ----------
app.get('/api/items', (req, res) => {
  const where = []; const args = [];
  if (req.query.status) { where.push('a.status = ?'); args.push(String(req.query.status)); }
  if (req.query.owner) { where.push('a.owner = ?'); args.push(String(req.query.owner)); }
  const rows = db.prepare(`SELECT a.*, m.title AS meeting_title FROM action_items a JOIN meetings m ON m.id = a.meeting_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY (a.due_date IS NULL), a.due_date, a.id`).all(...args);
  res.json(rows.map(withOverdue));
});

app.post('/api/meetings/:id/items', (req, res) => {
  const id = parseId(req.params.id);
  getMeeting(id);
  const b = req.body || {};
  const itemId = insertItem(id, { title: cleanStr(b.title, 'title', { required: true, max: 300 }), owner: cleanStr(b.owner, 'owner', { max: 100 }), due_date: cleanDate(b.due_date, 'due_date') });
  touchMeeting(id);
  res.status(201).json(getItem(itemId));
});

app.patch('/api/items/:id', (req, res) => {
  const id = parseId(req.params.id);
  const cur = getItem(id);
  const b = req.body || {};
  if (['done', 'carried'].includes(cur.status) && b.status === undefined) throw new ApiError(409, `item is ${cur.status}; reopen it first`);
  const title = b.title !== undefined ? cleanStr(b.title, 'title', { required: true, max: 300 }) : cur.title;
  const owner = b.owner !== undefined ? cleanStr(b.owner, 'owner', { max: 100 }) : cur.owner;
  const due = b.due_date !== undefined ? cleanDate(b.due_date, 'due_date') : cur.due_date;
  const status = b.status ?? cur.status;
  if (!ITEM_STATUS.includes(status)) throw new ApiError(400, `status must be one of ${ITEM_STATUS.join(', ')}`);
  if (['done', 'cancelled'].includes(status) && status !== cur.status && !(b.outcome || cur.outcome)) throw new ApiError(400, 'outcome is required to close an item (use /close)');
  db.prepare("UPDATE action_items SET title=?, owner=?, due_date=?, status=?, outcome=?, updated_at=datetime('now') WHERE id=?")
    .run(title, owner, due, status, b.outcome !== undefined ? cleanStr(b.outcome, 'outcome') : cur.outcome, id);
  if (owner !== cur.owner) logHistory(id, 'reassigned', `${cur.owner || '(none)'} -> ${owner || '(none)'}`);
  if (status !== cur.status) logHistory(id, 'status_changed', `${cur.status} -> ${status}`);
  if (due !== cur.due_date) logHistory(id, 'due_date_changed', `${cur.due_date || '(none)'} -> ${due || '(none)'}`);
  if (title !== cur.title) logHistory(id, 'renamed', title);
  touchMeeting(cur.meeting_id);
  res.json(withOverdue(getItem(id)));
});

// Close an item and record its outcome
app.post('/api/items/:id/close', (req, res) => {
  const id = parseId(req.params.id);
  const cur = getItem(id);
  const outcome = cleanStr(req.body?.outcome, 'outcome', { required: true, max: 2000 });
  const status = req.body?.status === 'cancelled' ? 'cancelled' : 'done';
  if (['done', 'cancelled', 'carried'].includes(cur.status)) throw new ApiError(409, `item is already ${cur.status}`);
  db.prepare("UPDATE action_items SET status=?, outcome=?, updated_at=datetime('now') WHERE id=?").run(status, outcome, id);
  logHistory(id, 'closed', `${status}: ${outcome}`);
  touchMeeting(cur.meeting_id);
  res.json(getItem(id));
});

// Full history of an item, following its carry-forward chain
app.get('/api/items/:id/history', (req, res) => {
  let cur = getItem(parseId(req.params.id));
  const chain = [cur];
  while (cur.carried_from_id && chain.length < 50) { cur = getItem(cur.carried_from_id); chain.unshift(cur); }
  const ids = chain.map((c) => c.id);
  const events = db.prepare(`SELECT h.*, a.meeting_id FROM item_history h JOIN action_items a ON a.id = h.item_id WHERE h.item_id IN (${ids.map(() => '?').join(',')}) ORDER BY h.at, h.id`).all(...ids);
  res.json({ chain: chain.map((c) => ({ id: c.id, meeting_id: c.meeting_id, status: c.status })), events });
});

// Bulk reassign (colleague on leave / work transfer)
app.post('/api/items/reassign', (req, res) => {
  const from = cleanStr(req.body?.from, 'from', { required: true, max: 100 });
  const to = cleanStr(req.body?.to, 'to', { required: true, max: 100 });
  if (from === to) throw new ApiError(400, 'from and to must differ');
  const rows = db.prepare("SELECT id, meeting_id FROM action_items WHERE owner = ? AND status IN ('open','in_progress')").all(from);
  db.transaction(() => rows.forEach((r) => {
    db.prepare("UPDATE action_items SET owner=?, updated_at=datetime('now') WHERE id=?").run(to, r.id);
    logHistory(r.id, 'reassigned', `${from} -> ${to} (bulk handoff)`);
  }))();
  logger.info({ event: 'bulk_reassigned', from, to, count: rows.length });
  res.json({ reassigned: rows.length });
});

// ---------- SPECIAL FEATURE: Handoff Radar + AI nudges ----------
app.get('/api/radar', (req, res) => {
  const t = todayStr();
  const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const open = db.prepare(`SELECT a.*, m.title AS meeting_title,
      (SELECT COUNT(*) FROM action_items p WHERE p.id = a.carried_from_id) AS has_parent
    FROM action_items a JOIN meetings m ON m.id = a.meeting_id WHERE a.status IN ('open','in_progress')`).all();
  const carries = (id) => { let n = 0; let cur = db.prepare('SELECT carried_from_id FROM action_items WHERE id=?').get(id); while (cur && cur.carried_from_id && n < 50) { n++; cur = db.prepare('SELECT carried_from_id FROM action_items WHERE id=?').get(cur.carried_from_id); } return n; };
  const scored = open.map((i) => {
    const overdueDays = i.due_date && i.due_date < t ? daysBetween(i.due_date, t) : 0;
    const dueSoon = i.due_date && i.due_date >= t && i.due_date <= soon;
    const c = carries(i.id);
    const risk = (overdueDays ? 3 + Math.min(overdueDays, 10) * 0.3 : 0) + (dueSoon ? 1 : 0) + c * 1.5 + (i.owner ? 0 : 2) + (i.due_date ? 0 : 0.5);
    return { id: i.id, title: i.title, owner: i.owner, due_date: i.due_date, meeting_id: i.meeting_id, meeting_title: i.meeting_title, overdueDays, carries: c, risk: +risk.toFixed(1) };
  }).sort((a, b) => b.risk - a.risk);
  const byOwner = {};
  for (const s of scored) {
    const k = s.owner || '(unassigned)';
    byOwner[k] ||= { owner: k, open: 0, overdue: 0, risk: 0 };
    byOwner[k].open++; byOwner[k].risk += s.risk; if (s.overdueDays) byOwner[k].overdue++;
  }
  const people = Object.values(byOwner).map((p) => ({ ...p, risk: +p.risk.toFixed(1), level: p.risk >= 8 ? 'high' : p.risk >= 4 ? 'medium' : 'low' })).sort((a, b) => b.risk - a.risk);
  res.json({ people, at_risk_items: scored.slice(0, 10) });
});

app.post('/api/items/:id/nudge', async (req, res) => {
  const id = parseId(req.params.id);
  const item = getItem(id);
  const m = getMeeting(item.meeting_id);
  let carries = 0; let cur = item;
  while (cur.carried_from_id && carries < 50) { carries++; cur = getItem(cur.carried_from_id); }
  const daysOverdue = item.due_date && item.due_date < todayStr() ? daysBetween(item.due_date, todayStr()) : 0;
  const out = await ai.draftNudge(item, { meetingTitle: m.title, daysOverdue, carries });
  logHistory(id, 'nudge_drafted', `ai_used=${out.ai_used}`);
  res.json(out);
});

// ---------- knowledge base ----------
app.get('/api/kb', (req, res) => {
  const q = cleanStr(req.query.q, 'q', { max: 100 });
  const rows = q
    ? db.prepare('SELECT * FROM kb_docs WHERE title LIKE ? OR content LIKE ? OR tags LIKE ? ORDER BY id DESC').all(`%${q}%`, `%${q}%`, `%${q}%`)
    : db.prepare('SELECT * FROM kb_docs ORDER BY id DESC').all();
  res.json(rows);
});
app.post('/api/kb', (req, res) => {
  const b = req.body || {};
  const info = db.prepare('INSERT INTO kb_docs (title, content, tags) VALUES (?,?,?)').run(
    cleanStr(b.title, 'title', { required: true, max: 200 }), cleanStr(b.content, 'content', { required: true, max: 50000 }), cleanStr(b.tags, 'tags', { max: 200 }));
  logger.info({ event: 'kb_doc_created', docId: Number(info.lastInsertRowid) });
  res.status(201).json(db.prepare('SELECT * FROM kb_docs WHERE id=?').get(info.lastInsertRowid));
});
app.delete('/api/kb/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (!db.prepare('DELETE FROM kb_docs WHERE id=?').run(id).changes) throw new ApiError(404, 'document not found');
  logger.info({ event: 'kb_doc_deleted', docId: id });
  res.status(204).end();
});

// ---------- static + errors ----------
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON body' });
  if (err instanceof ApiError) {
    logger.warn({ event: 'request_rejected', status: err.status, error: err.message, path: req.path });
    return res.status(err.status).json({ error: err.message });
  }
  logger.error({ event: 'unhandled_error', path: req.path, method: req.method, error: err.message, stack: err.stack });
  res.status(500).json({ error: 'internal server error', requestId: als.getStore()?.reqId });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  seedIfEmpty();
  app.listen(PORT, () => logger.info({ event: 'server_started', port: Number(PORT), ai_configured: !!process.env.GEMINI_API_KEY }));
}
module.exports = app;
