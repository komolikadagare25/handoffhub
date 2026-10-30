// Handover Pack = grounded facts (this file, deterministic) + narrative prose (AI, validated against these facts).
// Every number, date, name and link in the pack comes from the database. The AI only writes explanations on top,
// and anything it returns that is not backed by the data (unknown meeting ids, unknown people) is discarded.
const db = require('./db');
const { todayStr, scoreItem } = require('./risk');

const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s || '');
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const ORG = process.env.ORG_NAME || 'DIGIPLUS IT';
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// The meeting plus up to 3 ancestors (follow-ups keep prev_meeting_id), newest first.
function meetingChain(m, max = 3) {
  const out = [m];
  let cur = m;
  while (cur.prev_meeting_id && out.length <= max) {
    cur = db.prepare('SELECT * FROM meetings WHERE id = ?').get(cur.prev_meeting_id);
    if (!cur) break;
    out.push(cur);
  }
  return out;
}

// What happened to an item across every meeting it was carried through.
function itemTrail(item) {
  const ids = [item.id];
  let cur = item;
  while (cur.carried_from_id && ids.length < 20) {
    cur = db.prepare('SELECT * FROM action_items WHERE id = ?').get(cur.carried_from_id);
    if (!cur) break;
    ids.unshift(cur.id);
  }
  const events = db.prepare(
    `SELECT event, detail, at FROM item_history WHERE item_id IN (${ids.map(() => '?').join(',')}) ORDER BY at, id`
  ).all(...ids).filter((e) => ['reassigned', 'status_changed', 'due_date_changed'].includes(e.event));
  return { meetingsTouched: ids.length, events: events.slice(-4).map((e) => `${e.at.slice(0, 10)} ${e.event.replace(/_/g, ' ')}: ${e.detail}`) };
}

function buildHandoverData(person, { to = '', until = null } = {}) {
  const t = todayStr();
  const rows = db.prepare(`SELECT * FROM action_items
    WHERE lower(owner) = lower(?) AND status IN ('open','in_progress')
    ORDER BY meeting_id, (due_date IS NULL), due_date, id`).all(person);

  const candidates = new Map(); // name -> { name, reasons:Set, weight }
  const addCandidate = (name, reason, weight = 1) => {
    if (!name || same(name, person) || (to && same(name, to))) return;
    const key = name.toLowerCase();
    const c = candidates.get(key) || { name, reasons: new Set(), weight: 0 };
    c.reasons.add(reason); c.weight += weight;
    candidates.set(key, c);
  };

  const byMeeting = new Map();
  const kbDocs = new Map(); // doc_id -> { doc_id, title, reasons:Set }
  const risks = [];
  let overdue = 0; let dueSoon = 0; let carried = 0;

  for (const row of rows) {
    const sc = scoreItem(row);
    const trail = itemTrail(row);
    const item = {
      id: row.id, title: row.title, due_date: row.due_date, status: row.status, source: row.source,
      overdue_days: sc.overdueDays, carries: sc.carries, risk: sc.risk, trail: trail.events,
    };
    if (sc.overdueDays) overdue++;
    if (sc.dueSoon) dueSoon++;
    if (sc.carries) carried++;
    const flags = [];
    if (sc.overdueDays) flags.push(`${plural(sc.overdueDays, 'day')} overdue (was due ${row.due_date})`);
    else if (sc.dueSoon) flags.push(`due ${row.due_date}, within 3 days`);
    if (sc.carries) flags.push(`carried forward ${plural(sc.carries, 'time')} and keeps slipping`);
    if (!row.due_date) flags.push('has no due date');
    if (flags.length) risks.push({ risk: sc.risk, text: `"${row.title}": ${flags.join('; ')}.` });

    // previous owners of this item are people who know its history
    for (const e of trail.events) {
      const m = e.match(/reassigned: (.+?) -> (.+?)(?: \(|$)/);
      if (m && same(m[2], person) && m[1] !== '(none)') addCandidate(m[1], `previously owned "${clip(row.title, 50)}"`, 2);
    }

    if (!byMeeting.has(row.meeting_id)) {
      const m = db.prepare('SELECT * FROM meetings WHERE id = ?').get(row.meeting_id);
      const chain = meetingChain(m);
      const context = chain
        .map((c) => ({ id: c.id, title: c.title, date: c.scheduled_at, summary: c.summary, decisions: parse(c.decisions, []) }))
        .filter((c) => c.summary || c.decisions.length);
      // knowledge links: this meeting's own, else inherited from the nearest ancestor that has any
      for (const c of chain) {
        const links = parse(c.kb_links, []);
        if (links.length) { links.forEach((l) => {
          const d = kbDocs.get(l.doc_id) || { doc_id: l.doc_id, title: l.title, reasons: new Set() };
          if (l.reason) d.reasons.add(l.reason);
          kbDocs.set(l.doc_id, d);
        }); break; }
      }
      const participants = parse(m.participants, []);
      participants.forEach((p) => addCandidate(p, `attended "${clip(m.title, 50)}"`, 1));
      // people who own other open work in the same meeting are dependencies
      db.prepare(`SELECT DISTINCT owner FROM action_items WHERE meeting_id = ? AND owner != '' AND status IN ('open','in_progress')`)
        .all(m.id).forEach((o) => addCandidate(o.owner, `owns related open work in "${clip(m.title, 50)}"`, 1.5));
      byMeeting.set(row.meeting_id, {
        id: m.id, title: m.title, type: m.type, status: m.status, scheduled_at: m.scheduled_at,
        agenda: m.agenda, participants, context, items: [],
      });
    }
    byMeeting.get(row.meeting_id).items.push(item);
  }

  const recently_closed = db.prepare(`SELECT a.title, a.outcome, a.updated_at, m.title AS meeting_title
    FROM action_items a JOIN meetings m ON m.id = a.meeting_id
    WHERE lower(a.owner) = lower(?) AND a.status = 'done' AND a.updated_at >= datetime('now','-30 days')
    ORDER BY a.updated_at DESC LIMIT 10`).all(person);

  return {
    person, to, until, generated_on: t,
    totals: { open: rows.length, overdue, due_soon: dueSoon, carried, meetings: byMeeting.size },
    meetings: [...byMeeting.values()],
    kb_docs: [...kbDocs.values()].map((d) => ({ ...d, reasons: [...d.reasons] })),
    candidates: [...candidates.values()].sort((a, b) => b.weight - a.weight).slice(0, 6).map((c) => ({ name: c.name, reasons: [...c.reasons] })),
    recently_closed,
    risks: risks.sort((a, b) => b.risk - a.risk).slice(0, 8).map((r) => r.text),
  };
}

// Compact, id-light view of the pack sent to the model (keeps the prompt small and focused).
function aiContext(data) {
  return {
    person: data.person, covering: data.to || null, back_on: data.until || null, today: data.generated_on, totals: data.totals,
    meetings: data.meetings.map((m) => ({
      meeting_id: m.id, title: m.title, status: m.status, agenda: clip(m.agenda, 200),
      background: m.context.map((c) => ({ from: c.title, summary: clip(c.summary, 400), decisions: c.decisions })),
      open_items: m.items.map((i) => ({ title: i.title, due: i.due_date, status: i.status, overdue_days: i.overdue_days, carried_times: i.carries, history: i.trail })),
    })),
    people_who_know_this: data.candidates,
    knowledge_docs: data.kb_docs.map((d) => d.title),
    known_risks: data.risks,
  };
}

// Deterministic narrative: used when the AI is unavailable and to fill any gap in the AI's answer.
function fallbackNarrative(data) {
  const tt = data.totals;
  const flags = [tt.overdue && `${tt.overdue} overdue`, tt.due_soon && `${tt.due_soon} due within 3 days`, tt.carried && `${tt.carried} carried forward before`].filter(Boolean);
  return {
    overview: `${data.person} currently owns ${plural(tt.open, 'open item')} across ${plural(tt.meetings, 'meeting')}${flags.length ? ` (${flags.join(', ')})` : ''}. ` +
      `${data.to ? `${data.to} is covering` : 'A covering colleague should pick up'} these${data.until ? ` until ${data.person} is back on ${data.until}` : ''}. ` +
      `Start with the items flagged under Risks, then work through each meeting below.`,
    meetings: Object.fromEntries(data.meetings.map((m) => {
      const ctx = m.context[0];
      const sorted = [...m.items].sort((a, b) => b.risk - a.risk);
      return [m.id, {
        context: ctx
          ? `${clip(ctx.summary, 320) || 'No summary recorded.'}${ctx.decisions.length ? ` ${plural(ctx.decisions.length, 'decision')} on record.` : ''}`
          : 'No recap has been recorded for this meeting yet; read the raw notes before acting.',
        first_steps: sorted.slice(0, 3).map((i) => (i.overdue_days
          ? `Get a status on "${i.title}" today; it is ${plural(i.overdue_days, 'day')} overdue.`
          : `Review "${i.title}"${i.due_date ? ` (due ${i.due_date})` : ' and agree a due date'}.`)),
      }];
    })),
    risks: data.risks,
    who_to_ask: data.candidates.slice(0, 4).map((c) => ({ name: c.name, ask_about: c.reasons.slice(0, 2).join('; ') })),
  };
}

function renderMarkdown(data, narrative, meta = {}) {
  const L = [];
  const tt = data.totals;
  L.push(`# Handover pack: ${data.person}${data.to ? ` → ${data.to}` : ''}`);
  L.push(`_${ORG} · Generated ${data.generated_on}${data.until ? ` · ${data.person} back on ${data.until}` : ''} · ${meta.ai_used ? 'narrative written by AI from your workspace data' : 'narrative generated from templates (AI unavailable)'}_`);
  L.push('', '## Overview', narrative.overview, '');
  L.push('## At a glance', '', '| Open items | Overdue | Due in 3 days | Carried before | Meetings |', '|---|---|---|---|---|',
    `| ${tt.open} | ${tt.overdue} | ${tt.due_soon} | ${tt.carried} | ${tt.meetings} |`, '');

  if (narrative.risks.length) { L.push('## Risks: look at these first', ...narrative.risks.map((r) => `- ${r}`), ''); }

  L.push('## Open items by meeting', '');
  for (const m of data.meetings) {
    const n = narrative.meetings[m.id] || {};
    L.push(`### ${m.title}`, `_${m.type} · ${m.status}${m.scheduled_at ? ` · ${m.scheduled_at}` : ''}${m.participants.length ? ` · with ${m.participants.join(', ')}` : ''}_`, '');
    if (n.context) L.push(`**Context:** ${n.context}`, '');
    const decisions = m.context.flatMap((c) => c.decisions).slice(0, 6);
    if (decisions.length) L.push('**Decisions in force:**', ...decisions.map((d) => `- ${d}`), '');
    L.push('**Your open items:**');
    for (const i of m.items) {
      const bits = [i.status.replace('_', ' '), i.due_date ? `due ${i.due_date}` : 'no due date'];
      if (i.overdue_days) bits.push(`⚠ ${plural(i.overdue_days, 'day')} overdue`);
      if (i.carries) bits.push(`carried ${i.carries}×`);
      L.push(`- [ ] **${i.title}**: ${bits.join(' · ')}`);
      i.trail.forEach((e) => L.push(`  - ${e}`));
    }
    L.push('');
    if (n.first_steps?.length) L.push('**First steps:**', ...n.first_steps.map((s, k) => `${k + 1}. ${s}`), '');
  }

  if (data.kb_docs.length) {
    L.push('## Linked knowledge-base docs', ...data.kb_docs.map((d) => `- **${d.title}**${d.reasons.length ? `: ${d.reasons[0]}` : ''}`), '');
  }
  if (narrative.who_to_ask.length) {
    L.push('## Who to ask', ...narrative.who_to_ask.map((w) => `- **${w.name}**: ${w.ask_about}`), '');
  }
  if (data.recently_closed.length) {
    L.push('## Recently completed (last 30 days)', ...data.recently_closed.map((c) => `- ${c.title}${c.outcome ? `: ${c.outcome}` : ''}`), '');
  }
  L.push('---', `_Prepared with HandoffHub for ${ORG}. Review before sending: facts come from the workspace, prose may be AI-written._`);
  return L.join('\n');
}

module.exports = { buildHandoverData, aiContext, fallbackNarrative, renderMarkdown };