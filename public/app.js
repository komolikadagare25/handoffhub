const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
function toast(msg, ms = 3200) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), ms);
}
// wrap a click handler: disables button, shows errors as toasts
function guarded(btn, fn) {
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try { await fn(); } catch (e) { toast('⚠ ' + e.message); } finally { btn.disabled = false; }
  });
}
const modal = (html) => { $('#modal-body').innerHTML = html; $('#modal').showModal(); };
const aiTag = (r) => (r.fallback ? '<span class="chip warn">fallback (AI unavailable)</span>' : r.ai_used ? '<span class="chip">✨ AI</span>' : '');
const statusChip = (s) => `<span class="pill ${esc(s)}">${esc(String(s).replace('_', ' '))}</span>`;
const PALETTE = ['#2563eb', '#0e9f8e', '#7c3aed', '#d97706', '#db2777', '#0891b2', '#4f46e5', '#059669'];
const initials = (n) => String(n || '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
const avatar = (n, cls = '') => (n && !String(n).startsWith('(')) ? `<span class="avatar ${cls}" title="${esc(n)}" style="background:${PALETTE[[...String(n)].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length]}">${esc(initials(n))}</span>` : `<span class="avatar none ${cls}" title="Unassigned">?</span>`;
const avatars = (list) => list.length ? `<span class="avatars">${list.slice(0, 5).map((n) => avatar(n)).join('')}${list.length > 5 ? `<span class="avatar" style="background:#64748b">+${list.length - 5}</span>` : ''}</span>` : '';
const who = (n) => `<span class="who">${avatar(n)}${n ? esc(n) : '<span class="muted">Unassigned</span>'}</span>`;
const pageHead = (title, sub = '', right = '') => `<div class="page-head"><div><h2>${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div>${right}</div>`;
const tbl = (html) => `<div class="tbl-wrap">${html}</div>`;
const SVG = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const IC = {
  list: SVG('<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
  alert: SVG('<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'),
  clock: SVG('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
  user: SVG('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  check: SVG('<path d="M20 6L9 17l-5-5"/>'),
  cal: SVG('<rect x="3" y="4" width="18" height="18" rx="2.5"/><path d="M16 2v4M8 2v4M3 10h18"/>'),
};
const dueCell = (i) => (i.due_date ? `<span class="${i.overdue ? 'overdue' : ''}">${esc(i.due_date)}${i.overdue ? ' ⚠' : ''}</span>` : '<span class="muted">—</span>');

// ---------- navigation ----------
const views = { dashboard: viewDashboard, meetings: viewMeetings, board: viewBoard, items: viewItems, radar: viewRadar, handover: viewHandover, kb: viewKb };
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
function go(view, arg) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === (view === 'meeting' ? 'meetings' : view)));
  (view === 'meeting' ? viewMeeting : views[view])(arg).catch((e) => { app.innerHTML = `<div class="card">⚠ ${esc(e.message)}</div>`; });
}

// ---------- meetings list ----------
async function viewMeetings() {
  const list = await api('/meetings');
  app.innerHTML = `
  ${pageHead('Meetings & work transfers', 'Every discussion and handoff in one place, with its agenda, notes, decisions and open items.')}
  <details class="card"><summary><span class="plus">+</span> New meeting or work transfer</summary>
    <div class="grid2 form">
      <div><label>Title *</label><input id="m-title" maxlength="200" placeholder="e.g. Sprint planning"></div>
      <div><label>Type</label><select id="m-type"><option value="meeting">Meeting</option><option value="handoff">Work transfer (handoff)</option></select></div>
      <div><label>Participants (comma separated)</label><input id="m-people" placeholder="Aarav, Meera"></div>
      <div><label>Date</label><input id="m-date" type="date"></div>
    </div>
    <label>Agenda</label><textarea id="m-agenda" style="min-height:60px"></textarea>
    <div style="margin-top:14px"><button id="m-create">Create</button></div>
  </details>
  <div class="card">${list.length ? list.map((m) => `
    <div class="list-item" data-id="${m.id}">
      <div><strong>${esc(m.title)}</strong> <span class="chip neutral" style="margin-left:6px">${m.type === 'handoff' ? '⇄ ' : ''}${esc(m.type === 'handoff' ? 'work transfer' : m.type)}</span>
      <div class="list-meta">${avatars(m.participants)}<span>${esc(m.participants.join(', ') || 'no participants')}</span><span>·</span><span>${m.scheduled_at ? esc(m.scheduled_at) : 'no date'}</span></div></div>
      <div class="row" style="gap:18px"><span class="pill ${esc(m.status)}">${esc(m.status)}</span>
        <div class="progress"><span><b style="color:var(--ink)">${m.open_items}</b> open of ${m.total_items}</span><div class="bar ${m.open_items ? '' : 'low'}"><i style="width:${m.total_items ? ((m.total_items - m.open_items) / m.total_items) * 100 : 0}%"></i></div></div></div>
    </div>`).join('') : '<div class="empty"><b>No meetings yet</b>Create your first one above.</div>'}</div>`;
  app.querySelectorAll('.list-item').forEach((el) => el.addEventListener('click', () => go('meeting', el.dataset.id)));
  guarded($('#m-create'), async () => {
    const m = await api('/meetings', { method: 'POST', body: {
      title: $('#m-title').value, type: $('#m-type').value, agenda: $('#m-agenda').value,
      participants: $('#m-people').value.split(',').map((s) => s.trim()).filter(Boolean), scheduled_at: $('#m-date').value || null } });
    toast('Created'); go('meeting', m.id);
  });
}

// ---------- meeting detail ----------
async function viewMeeting(id) {
  const m = await api('/meetings/' + id);
  const people = m.participants;
  app.innerHTML = `
  <a href="#" id="back" class="crumb">← All meetings</a>
  <div class="card">
    <div class="row"><h2 class="grow" style="margin:0;font-size:24px">${esc(m.title)}</h2>
      <span class="chip neutral">${esc(m.type === 'handoff' ? 'work transfer' : m.type)}</span>
      <select id="m-status" style="width:auto">${['draft', 'scheduled', 'completed', 'archived'].map((s) => `<option ${s === m.status ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
    <div class="list-meta" style="margin-bottom:6px">${avatars(people)}<span>${esc(people.join(', ') || 'No participants')}</span><span>·</span><span>${m.scheduled_at || 'no date'}</span>${m.prev_meeting_id ? ` · <span>·</span><span>follows <a href="#" id="prev">meeting #${m.prev_meeting_id}</a></span>` : ''}</div>
    ${m.agenda ? `<p><strong>Agenda:</strong> ${esc(m.agenda)}</p>` : ''}
  </div>

  <div class="card">
    <h3 style="margin-top:0">Raw notes → AI recap</h3>
    <p class="muted">Paste notes, chat excerpts, an email thread or a transcript.</p>
    <textarea id="notes" placeholder="Paste anything unstructured here...">${esc(m.notes)}</textarea>
    <div class="row" style="margin-top:10px"><button id="recap" class="ai-btn">✨ Generate recap for review</button><button class="ghost" id="save-notes">Save notes only</button><span class="muted">Nothing is saved until you approve it.</span></div>
    ${m.summary ? `<div class="brief"><strong>Summary</strong><p>${esc(m.summary)}</p>
      ${m.decisions.length ? `<strong>Decisions</strong><ul>${m.decisions.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}</div>` : ''}
  </div>

  <div class="card">
    <div class="row"><h3 class="grow" style="margin:0">Action items</h3>
      <button class="ghost small" id="carry">Carry open items to next meeting →</button></div>
    ${'<div class="tbl-wrap"><table><thead><tr><th>Item</th><th>Owner</th><th>Due</th><th>Status</th><th></th></tr></thead><tbody>'}
    ${m.items.map((i) => `<tr data-id="${i.id}">
      <td>${esc(i.title)} ${i.source === 'ai' ? '<span class="chip">✨</span>' : ''}${i.carried_from_id ? '<span class="chip">carried</span>' : ''}${i.outcome ? `<br><span class="muted">Outcome: ${esc(i.outcome)}</span>` : ''}</td>
      <td>${who(i.owner)}</td><td>${dueCell(i)}</td><td>${statusChip(i.status)}</td>
      <td style="white-space:nowrap;text-align:right">
        ${['open', 'in_progress'].includes(i.status) ? `<button class="small ghost act-edit">Edit</button> <button class="small act-close">Close</button> <button class="small ghost act-nudge">Nudge</button>` : ''}
        <button class="small ghost act-history">History</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No items yet.</td></tr>'}
    </tbody></table></div>
    <h3 style="padding-top:14px;border-top:1px solid var(--line)">Add item</h3>
    <div class="row"><input class="grow" id="i-title" placeholder="What needs to be done?"><input id="i-owner" list="people" placeholder="Owner" style="width:150px"><input id="i-due" type="date" style="width:160px"><button id="i-add">Add</button></div>
    <datalist id="people">${people.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
  </div>

  <div class="grid2">
    <div class="card"><h3 style="margin-top:0">Catch-up brief</h3>
      <p class="muted">For someone who missed it or is taking over.</p>
      <div class="row"><input id="who" list="people" placeholder="Person (optional)" class="grow"><button id="catchup" class="ai-btn">✨ Generate</button></div><div id="brief"></div></div>
    <div class="card"><h3 style="margin-top:0">Linked knowledge</h3>
      <button class="ghost" id="link">✨ Link to knowledge base</button>
      <div id="links">${m.kb_links.map((l) => `<p><strong>${esc(l.title)}</strong><br><span class="muted">${esc(l.reason)} (${Math.round(l.score * 100)}%)</span></p>`).join('')}</div></div>
  </div>`;

  $('#back').onclick = (e) => { e.preventDefault(); go('meetings'); };
  if ($('#prev')) $('#prev').onclick = (e) => { e.preventDefault(); go('meeting', m.prev_meeting_id); };
  $('#m-status').onchange = async (e) => { try { await api('/meetings/' + id, { method: 'PUT', body: { status: e.target.value } }); toast('Status updated'); } catch (er) { toast('⚠ ' + er.message); } };
  guarded($('#save-notes'), async () => { await api('/meetings/' + id, { method: 'PUT', body: { notes: $('#notes').value } }); toast('Notes saved'); });
  guarded($('#recap'), async () => {
    const notes = $('#notes').value;
    toast('Generating preview…', 15000);
    const r = await api(`/meetings/${id}/recap/preview`, { method: 'POST', body: { notes } });
    $('#toast').classList.remove('show');
    reviewRecap(id, notes, r, people, m.items.length, () => go('meeting', id));
  });
  guarded($('#i-add'), async () => {
    await api(`/meetings/${id}/items`, { method: 'POST', body: { title: $('#i-title').value, owner: $('#i-owner').value, due_date: $('#i-due').value || null } });
    go('meeting', id);
  });
  guarded($('#carry'), async () => {
    if (!confirm('Create a follow-up and carry all open items into it?')) return;
    const r = await api(`/meetings/${id}/carry-forward`, { method: 'POST', body: {} });
    toast(`${r.carried} item(s) carried forward`); go('meeting', r.meeting.id);
  });
  guarded($('#catchup'), async () => {
    $('#brief').innerHTML = '<p class="muted">Thinking…</p>';
    const b = await api(`/meetings/${id}/catchup?person=${encodeURIComponent($('#who').value)}`);
    const ul = (a) => (a.length ? `<ul>${a.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="muted">None</p>');
    $('#brief').innerHTML = `<div class="brief">${aiTag(b)}<p>${esc(b.brief)}</p><strong>Key decisions</strong>${ul(b.key_decisions)}<strong>Your actions</strong>${ul(b.your_actions)}<strong>Risks</strong>${ul(b.risks)}</div>`;
  });
  guarded($('#link'), async () => {
    const r = await api(`/meetings/${id}/link-kb`, { method: 'POST' });
    $('#links').innerHTML = (r.links.map((l) => `<p><strong>${esc(l.title)}</strong><br><span class="muted">${esc(l.reason)} (${Math.round(l.score * 100)}%)</span></p>`).join('') || '<p class="muted">Nothing relevant found.</p>') + aiTag(r);
  });
  wireItemActions(m.items, () => go('meeting', id));
}


// ---------- review before saving the AI recap ----------
function reviewRecap(id, notes, r, people, existing, done) {
  const row = (a = { title: '', owner: '', due_date: null }) => `<tr class="rr"><td><input type="checkbox" class="rr-on" checked aria-label="Include this item"></td>
    <td><input class="rr-title" value="${esc(a.title)}" placeholder="Action item"></td><td><input class="rr-owner" list="rr-people" value="${esc(a.owner)}" placeholder="Owner" style="width:120px"></td>
    <td><input class="rr-due" type="date" value="${esc(a.due_date || '')}" style="width:140px"></td></tr>`;
  modal(`<h3 style="margin-top:0">Review before saving</h3>
    <p class="muted">${aiTag(r)} Edit anything. Untick items that are wrong. <strong>Nothing is saved until you approve.</strong>
    ${existing ? ` This meeting already has ${existing} item(s); approved items are added to them.` : ''}</p>
    ${r.fallback ? `<p style="color:var(--warn)">AI unavailable (${esc(r.ai_error || 'unknown')}). This is a rule-based draft, so check it carefully.</p>` : ''}
    <label>Summary</label><textarea id="rv-summary" style="min-height:90px">${esc(r.summary)}</textarea>
    <label>Decisions (one per line)</label><textarea id="rv-decisions" style="min-height:70px">${esc(r.decisions.join('\n'))}</textarea>
    <label>Action items</label>
    <table class="rr"><thead><tr><th></th><th>Item</th><th>Owner</th><th>Due</th></tr></thead><tbody id="rv-rows">${r.action_items.map(row).join('')}</tbody></table>
    <datalist id="rr-people">${people.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
    <div class="row" style="margin-top:10px"><button class="ghost small" id="rv-add">+ Add row</button></div>
    <div class="row" style="margin-top:14px"><button id="rv-ok">✓ Approve & save</button><button class="ghost" id="rv-discard">Discard</button></div>`);
  $('#rv-add').onclick = () => $('#rv-rows').insertAdjacentHTML('beforeend', row());
  $('#rv-discard').onclick = () => { $('#modal').close(); toast('Discarded. Nothing was saved.'); };
  guarded($('#rv-ok'), async () => {
    const action_items = [...document.querySelectorAll('#rv-rows .rr')].filter((tr) => $('.rr-on', tr).checked && $('.rr-title', tr).value.trim())
      .map((tr) => ({ title: $('.rr-title', tr).value.trim(), owner: $('.rr-owner', tr).value.trim(), due_date: $('.rr-due', tr).value || null }));
    const out = await api(`/meetings/${id}/recap/apply`, { method: 'POST', body: {
      notes, summary: $('#rv-summary').value, decisions: $('#rv-decisions').value.split('\n').map((x) => x.trim()).filter(Boolean), action_items, ai_used: r.ai_used } });
    $('#modal').close(); toast(`Saved · ${out.created_item_ids.length} item(s) added`); done();
  });
}

function wireItemActions(items, refresh) {
  const find = (el) => items.find((i) => i.id === Number(el.closest('tr').dataset.id));
  app.querySelectorAll('.act-close').forEach((b) => b.addEventListener('click', () => {
    const it = find(b);
    modal(`<h3>Close: ${esc(it.title)}</h3><label>Outcome *</label><textarea id="outcome" placeholder="What was the result?"></textarea>
      <label>Result</label><select id="res"><option value="done">Done</option><option value="cancelled">Cancelled / not needed</option></select>
      <p><button id="do-close">Close item</button></p>`);
    guarded($('#do-close'), async () => { await api(`/items/${it.id}/close`, { method: 'POST', body: { outcome: $('#outcome').value, status: $('#res').value } }); $('#modal').close(); toast('Item closed'); refresh(); });
  }));
  app.querySelectorAll('.act-edit').forEach((b) => b.addEventListener('click', () => {
    const it = find(b);
    modal(`<h3>Edit item</h3><label>Title</label><input id="e-title" value="${esc(it.title)}"><label>Owner</label><input id="e-owner" value="${esc(it.owner)}">
      <label>Due</label><input id="e-due" type="date" value="${esc(it.due_date || '')}"><label>Status</label>
      <select id="e-status"><option ${it.status === 'open' ? 'selected' : ''} value="open">open</option><option ${it.status === 'in_progress' ? 'selected' : ''} value="in_progress">in progress</option></select>
      <p><button id="e-save">Save</button></p>`);
    guarded($('#e-save'), async () => { await api('/items/' + it.id, { method: 'PATCH', body: { title: $('#e-title').value, owner: $('#e-owner').value, due_date: $('#e-due').value || null, status: $('#e-status').value } }); $('#modal').close(); toast('Saved'); refresh(); });
  }));
  app.querySelectorAll('.act-history').forEach((b) => b.addEventListener('click', async () => {
    try {
      const h = await api(`/items/${find(b).id}/history`);
      modal(`<h3>History</h3>${h.chain.length > 1 ? `<p class="muted">Carried through ${h.chain.length} meetings</p>` : ''}<ul class="timeline">${h.events.map((e) => `<li><strong>${esc(e.event.replace(/_/g, ' '))}</strong> <span class="muted">${esc(e.at)} · meeting #${e.meeting_id}</span><br>${esc(e.detail)}</li>`).join('')}</ul>`);
    } catch (e) { toast('⚠ ' + e.message); }
  }));
  app.querySelectorAll('.act-nudge').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const it = find(b); const n = await api(`/items/${it.id}/nudge`, { method: 'POST' });
      modal(`<h3>Draft nudge for ${esc(it.owner || 'owner')}</h3>${aiTag(n)}<textarea id="nudge">${esc(n.message)}</textarea><p><button id="copy">Copy</button></p>`);
      $('#copy').onclick = () => { navigator.clipboard?.writeText($('#nudge').value); toast('Copied'); };
    } catch (e) { toast('⚠ ' + e.message); } finally { b.disabled = false; }
  }));
}


// ---------- dashboard ----------
async function viewDashboard() {
  const s = await api('/stats');
  const it = s.items;
  const stat = (n, label, cls, target, ic = IC.list) => `<button class="stat ${cls}" data-go="${target}"><span class="ic">${ic}</span><span class="n">${n}</span><span class="l">${label}</span></button>`;
  const maxOpen = Math.max(1, ...s.workload.map((w) => w.open));
  app.innerHTML = `<div class="hero"><div><span class="eyebrow">Handoff Hub</span><h2>Keep DIGIPLUS IT work moving when people are away</h2>
    <p>Someone going on leave? Generate a handover pack with every open item, the risks, linked docs and who to ask.</p></div><button id="d-pack">Create handover pack</button></div>
  <div class="stats">
    ${stat(it.active, `Open · ${it.in_progress} in progress`, '', 'board', IC.list)}
    ${stat(it.overdue, 'Overdue', it.overdue ? 'bad' : '', 'radar', IC.alert)}
    ${stat(it.due_soon, 'Due in 3 days', it.due_soon ? 'warn' : '', 'items', IC.clock)}
    ${stat(it.unassigned, 'Unassigned', it.unassigned ? 'warn' : '', 'items', IC.user)}
    ${stat(it.done_this_week, 'Closed this week', 'ok', 'board', IC.check)}
    ${stat(s.meetings.total, 'Meetings', '', 'meetings', IC.cal)}
  </div>
  <div class="grid2">
    <div class="card"><h3 style="margin-top:0">Needs attention</h3>
      ${s.top_risks.map((i) => `<div class="mini"><div><strong>${esc(i.title)}</strong><br><span class="muted">${esc(i.owner || 'unassigned')} · ${esc(i.meeting_title)}</span></div>
        <div style="text-align:right">${i.overdueDays ? `<span class="overdue">${i.overdueDays}d late</span>` : i.due_date ? `<span class="muted">${esc(i.due_date)}</span>` : ''}<br><span class="muted">risk ${i.risk}</span></div></div>`).join('') || '<div class="empty"><b>Nothing at risk</b>Every open item has an owner and a date.</div>'}
    </div>
    <div class="card"><h3 style="margin-top:0">Upcoming meetings</h3>
      ${s.meetings.upcoming.map((m) => `<div class="mini"><div><a href="#" class="mt" data-m="${m.id}"><strong>${esc(m.title)}</strong></a><br><span class="muted">${esc(m.type)} · ${esc(m.status)} · ${m.scheduled_at ? esc(m.scheduled_at) : 'no date'}</span></div><span class="muted">${m.open_items} open</span></div>`).join('') || '<p class="muted">No upcoming meetings.</p>'}
    </div>
    <div class="card"><h3 style="margin-top:0">Workload</h3>
      ${s.workload.map((w) => `<div style="margin-bottom:10px"><div class="row"><span class="who grow">${avatar(w.owner)}<strong>${esc(w.owner)}</strong></span><span class="muted">${w.open} open${w.overdue ? ` · <span class="overdue">${w.overdue} overdue</span>` : ''}</span></div><div class="bar ${w.level}"><i style="width:${(w.open / maxOpen) * 100}%"></i></div></div>`).join('') || '<p class="muted">No open work.</p>'}
    </div>
    <div class="card"><h3 style="margin-top:0">Recent activity</h3>
      ${s.activity.map((a) => `<div class="mini"><div><strong>${esc(a.title)}</strong><br><span class="muted">${esc(a.event.replace(/_/g, ' '))}${a.detail ? ': ' + esc(a.detail.slice(0, 70)) : ''}</span></div><span class="muted">${esc(a.at.slice(0, 10))}</span></div>`).join('') || '<p class="muted">No activity yet.</p>'}
    </div>
  </div>`;
  app.querySelectorAll('.stat').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
  app.querySelectorAll('.mt').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); go('meeting', a.dataset.m); }));
  $('#d-pack').onclick = () => go('handover');
}

// ---------- kanban board ----------
const BOARD_COLS = [['open', 'Open'], ['in_progress', 'In progress'], ['done', 'Done'], ['cancelled', 'Cancelled']];
async function viewBoard() {
  const owner = viewBoard.owner || '';
  const [all, people] = await Promise.all([api('/items'), api('/people')]);
  const items = all.filter((i) => i.status !== 'carried' && (!owner || (owner === '__none' ? !i.owner : i.owner === owner)));
  const card = (i) => `<div class="kcard ${i.overdue ? 'late' : ''}" draggable="true" data-id="${i.id}">
    <div class="kt">${esc(i.title)}</div>
    <div class="meta">${who(i.owner)}${i.due_date ? `<span class="${i.overdue ? 'overdue' : 'muted'}">${esc(i.due_date.slice(5))}${i.overdue ? ' ⚠' : ''}</span>` : ''}</div>
    <div class="muted" style="margin-top:8px">${esc(i.meeting_title)}</div>${i.outcome ? `<div class="muted">Outcome: ${esc(i.outcome.slice(0, 90))}</div>` : ''}
    <select class="kmove" aria-label="Move item to"><option value="">Move to…</option>${BOARD_COLS.filter(([k]) => k !== i.status).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>`;
  app.innerHTML = `${pageHead('Board', 'Drag cards between columns, or use the “Move to…” menu. Closing an item always asks for its outcome.')}
  <div class="row" style="margin-bottom:16px;justify-content:flex-end">
    <label style="margin:0">Owner</label><select id="b-owner" style="width:auto"><option value="">Everyone</option><option value="__none" ${owner === '__none' ? 'selected' : ''}>Unassigned</option>${people.map((p) => `<option ${p === owner ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></div>
  <div class="board">${BOARD_COLS.map(([k, l]) => { const col = items.filter((i) => i.status === k); return `<div class="kcol" data-status="${k}"><h3>${l} <span>${col.length}</span></h3>${col.map(card).join('') || '<p class="muted drop">Drop here</p>'}</div>`; }).join('')}</div>`;

  $('#b-owner').onchange = (e) => { viewBoard.owner = e.target.value; go('board'); };
  const move = async (id, to) => {
    const it = items.find((i) => i.id === id);
    if (!it || it.status === to) return;
    try {
      if (to === 'done' || to === 'cancelled') {
        modal(`<h3 style="margin-top:0">${to === 'done' ? 'Close' : 'Cancel'}: ${esc(it.title)}</h3><label>Outcome *</label><textarea id="outcome" placeholder="${to === 'done' ? 'What was the result?' : 'Why is this no longer needed?'}"></textarea><p><button id="do-move">${to === 'done' ? 'Mark done' : 'Mark cancelled'}</button></p>`);
        guarded($('#do-move'), async () => {
          const outcome = $('#outcome').value;
          if (['done', 'cancelled'].includes(it.status)) await api('/items/' + id, { method: 'PATCH', body: { status: to, outcome } });
          else await api(`/items/${id}/close`, { method: 'POST', body: { outcome, status: to } });
          $('#modal').close(); toast('Item updated'); go('board');
        });
      } else {
        await api('/items/' + id, { method: 'PATCH', body: { status: to } });
        toast(`Moved to ${to.replace('_', ' ')}`); go('board');
      }
    } catch (e) { toast('⚠ ' + e.message); }
  };
  app.querySelectorAll('.kcard').forEach((c) => {
    c.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', c.dataset.id); e.dataTransfer.effectAllowed = 'move'; c.classList.add('dragging'); });
    c.addEventListener('dragend', () => c.classList.remove('dragging'));
    $('.kmove', c).addEventListener('change', (e) => e.target.value && move(Number(c.dataset.id), e.target.value));
  });
  app.querySelectorAll('.kcol').forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('over'); });
    col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('over'); });
    col.addEventListener('drop', (e) => { e.preventDefault(); col.classList.remove('over'); move(Number(e.dataTransfer.getData('text/plain')), col.dataset.status); });
  });
}

// ---------- handover pack ----------
// Tiny renderer for the Markdown subset the server produces (headings, lists, tables, bold). Everything is escaped first.
function mdToHtml(md) {
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  const out = []; const lines = md.split('\n'); let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (/^\|/.test(l)) {
      const rows = []; while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const [head, , ...body] = rows;
      out.push(`<table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    let m;
    if ((m = l.match(/^(#{1,3}) (.*)/))) out.push(`<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`);
    else if (/^---+$/.test(l)) out.push('<hr>');
    else if ((m = l.match(/^(\s*)- \[ \] (.*)/))) out.push(`<div class="li" style="margin-left:${m[1].length * 8}px">☐ ${inline(m[2])}</div>`);
    else if ((m = l.match(/^(\s*)- (.*)/))) out.push(`<div class="li" style="margin-left:${m[1].length * 8 + 4}px">${m[1].length ? '◦' : '•'} ${inline(m[2])}</div>`);
    else if ((m = l.match(/^(\d+)\. (.*)/))) out.push(`<div class="li" style="margin-left:4px">${m[1]}. ${inline(m[2])}</div>`);
    else if ((m = l.match(/^_(.*)_$/))) out.push(`<p class="muted"><em>${esc(m[1])}</em></p>`);
    else out.push(`<p>${inline(l)}</p>`);
    i++;
  }
  return out.join('');
}

async function viewHandover() {
  const people = await api('/people');
  const pre = viewHandover.pre || {}; viewHandover.pre = null;
  app.innerHTML = `${pageHead('Handover pack', 'Pick the person going on leave. HandoffHub gathers their open items by meeting, adds background, risks, linked docs and who to ask, then writes it up as a document you can edit and export.')}
  <div class="card"><div class="grid2 form">
    <div><label>Going on leave *</label><input id="h-from" list="h-people" value="${esc(pre.from || '')}" placeholder="e.g. Meera"></div>
    <div><label>Covering colleague (optional)</label><input id="h-to" list="h-people" value="${esc(pre.to || '')}" placeholder="e.g. Rohan"></div>
    <div><label>Back on (optional)</label><input id="h-until" type="date"></div>
  </div><datalist id="h-people">${people.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
  <p><button id="h-go" class="ai-btn">✨ Generate handover pack</button></p></div><div id="h-out"></div>`;

  guarded($('#h-go'), async () => {
    const from = $('#h-from').value.trim(); const to = $('#h-to').value.trim(); const until = $('#h-until').value;
    if (!from) throw new Error('Choose who is going on leave');
    $('#h-out').innerHTML = '<div class="card muted">Gathering items and writing the handover…</div>';
    const q = new URLSearchParams({ from, ...(to && { to }), ...(until && { until }) });
    const r = await api('/handover?' + q);
    if (r.empty) { $('#h-out').innerHTML = `<div class="card">${esc(r.message)}</div>`; return; }
    let md = r.markdown;
    $('#h-out').innerHTML = `<div class="card">
      <div class="row"><strong class="grow">Handover pack for ${esc(from)}</strong>${aiTag(r)}<span class="chip">${r.totals.open} item${r.totals.open === 1 ? '' : 's'}</span><span class="chip">${r.totals.meetings} meeting${r.totals.meetings === 1 ? '' : 's'}</span>${r.totals.overdue ? `<span class="chip bad">${r.totals.overdue} overdue</span>` : ''}</div>
      ${r.fallback ? `<p class="muted">AI unavailable (${esc(r.ai_error || 'unknown')}). Facts are from your workspace; the prose is template-based.</p>` : ''}
      <div class="tabsw"><button class="small" id="t-prev">Preview</button><button class="small ghost" id="t-edit">Edit Markdown</button></div>
      <div id="h-preview" class="md">${mdToHtml(md)}</div>
      <textarea id="h-md" hidden spellcheck="false" style="min-height:420px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px"></textarea>
      <div class="row" style="margin-top:12px"><button id="h-dl">⬇ Download .md</button><button class="ghost" id="h-copy">Copy Markdown</button>
        ${to ? `<button class="ghost" id="h-reassign">Reassign ${r.totals.open} item(s) to ${esc(to)}</button>` : ''}</div></div>`;
    const show = (edit) => {
      $('#h-preview').hidden = edit; $('#h-md').hidden = !edit;
      $('#t-prev').classList.toggle('ghost', edit); $('#t-edit').classList.toggle('ghost', !edit);
      if (edit) $('#h-md').value = md; else $('#h-preview').innerHTML = mdToHtml(md);
    };
    $('#t-prev').onclick = () => show(false); $('#t-edit').onclick = () => show(true);
    $('#h-md').addEventListener('input', (e) => { md = e.target.value; });
    $('#h-dl').onclick = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
      a.download = `handover-${from.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${new Date().toISOString().slice(0, 10)}.md`;
      a.click(); URL.revokeObjectURL(a.href);
    };
    $('#h-copy').onclick = () => { navigator.clipboard?.writeText(md); toast('Markdown copied'); };
    if ($('#h-reassign')) guarded($('#h-reassign'), async () => {
      if (!confirm(`Move all of ${from}'s open items to ${to}? Each move is recorded in the item history.`)) return;
      const x = await api('/items/reassign', { method: 'POST', body: { from, to } });
      toast(`${x.reassigned} item(s) reassigned to ${to}`); $('#h-reassign').hidden = true;
    });
  });
  if (pre.from) $('#h-go').click();
}

// ---------- all items ----------
async function viewItems() {
  const status = viewItems.status || '';
  const items = await api('/items' + (status ? `?status=${status}` : ''));
  app.innerHTML = `${pageHead('Action items', 'Every action item across all meetings, tracked until it is closed with an outcome.')}
  <div class="card"><div class="row" style="margin-bottom:6px"><label style="margin:0">Status</label>
    <select id="f-status" style="width:auto"><option value="">All</option>${['open', 'in_progress', 'done', 'cancelled', 'carried'].map((s) => `<option ${s === status ? 'selected' : ''} value="${s}">${s.replace('_', ' ')}</option>`).join('')}</select></div>
  <div class="tbl-wrap"><table><thead><tr><th>Item</th><th>Owner</th><th>Due</th><th>Status</th><th>Meeting</th><th></th></tr></thead><tbody>
  ${items.map((i) => `<tr data-id="${i.id}"><td>${esc(i.title)}${i.outcome ? `<br><span class="muted">Outcome: ${esc(i.outcome)}</span>` : ''}</td><td>${who(i.owner)}</td><td>${dueCell(i)}</td><td>${statusChip(i.status)}</td>
    <td><a href="#" class="mt" data-m="${i.meeting_id}">${esc(i.meeting_title)}</a></td>
    <td style="white-space:nowrap">${['open', 'in_progress'].includes(i.status) ? '<button class="small ghost act-edit">Edit</button> <button class="small act-close">Close</button> <button class="small ghost act-nudge">Nudge</button>' : ''} <button class="small ghost act-history">History</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">Nothing here.</td></tr>'}
  </tbody></table></div></div>`;
  $('#f-status').onchange = (e) => { viewItems.status = e.target.value; go('items'); };
  app.querySelectorAll('.mt').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); go('meeting', a.dataset.m); }));
  wireItemActions(items, () => go('items'));
}

// ---------- special feature: radar ----------
async function viewRadar() {
  const r = await api('/radar');
  const max = Math.max(1, ...r.people.map((p) => p.risk));
  app.innerHTML = `${pageHead('Handoff Radar', 'Context-loss risk, scored from overdue days, times carried forward, missing owners and imminent due dates. Use it to decide who needs a nudge or cover.')}
  <div class="grid2">
    <div class="card"><h3 style="margin-top:0">Who is at risk</h3>
      ${r.people.map((p) => `<div style="margin-bottom:12px"><div class="row"><span class="who grow">${avatar(p.owner)}<strong>${esc(p.owner)}</strong></span><span class="chip ${p.level === 'high' ? 'bad' : p.level === 'medium' ? 'warn' : 'ok'}">${p.level}</span></div>
      <span class="muted">${p.open} open · ${p.overdue} overdue · score ${p.risk}</span><div class="bar ${p.level}"><i style="width:${(p.risk / max) * 100}%"></i></div></div>`).join('') || '<div class="empty"><b>All clear</b>No one is carrying risky work.</div>'}
    </div>
    <div class="card"><h3 style="margin-top:0">Cover for someone on leave</h3>
      <label>From</label><input id="r-from" placeholder="Person going on leave">
      <label>To</label><input id="r-to" placeholder="Person taking over">
      <p class="row"><button id="r-go">Reassign all their open items</button><button class="ghost" id="r-pack">📄 Handover pack…</button></p>
      <p class="muted">Every move is recorded in each item's history.</p></div>
  </div>
  <div class="card"><h3 style="margin-top:0">Items most likely to fall through</h3>
    <div class="tbl-wrap"><table><thead><tr><th>Item</th><th>Owner</th><th>Overdue</th><th>Carried</th><th>Score</th><th></th></tr></thead><tbody>
    ${r.at_risk_items.map((i) => `<tr data-id="${i.id}"><td>${esc(i.title)}<br><span class="muted">${esc(i.meeting_title)}</span></td><td>${i.owner ? who(i.owner) : '<span class="overdue">unassigned</span>'}</td>
      <td>${i.overdueDays ? `<span class="overdue">${i.overdueDays}d</span>` : '—'}</td><td>${i.carries}×</td><td><strong>${i.risk}</strong></td><td><button class="small act-nudge">Nudge</button></td></tr>`).join('')}
    </tbody></table></div></div>`;
  $('#r-pack').onclick = () => { viewHandover.pre = { from: $('#r-from').value, to: $('#r-to').value }; go('handover'); };
  guarded($('#r-go'), async () => { const x = await api('/items/reassign', { method: 'POST', body: { from: $('#r-from').value, to: $('#r-to').value } }); toast(`${x.reassigned} item(s) reassigned`); go('radar'); });
  wireItemActions(r.at_risk_items.map((i) => ({ ...i })), () => go('radar'));
}

// ---------- knowledge base ----------
async function viewKb() {
  const docs = await api('/kb');
  app.innerHTML = `${pageHead('Knowledge base', 'Team documents and past decisions. AI links the right ones to each meeting.')}
  <details class="card"><summary><span class="plus">+</span> Add a document</summary>
    <label>Title *</label><input id="k-title" maxlength="200"><label>Tags</label><input id="k-tags" placeholder="comma,separated">
    <label>Content *</label><textarea id="k-content"></textarea><p><button id="k-add">Add</button></p></details>
  <div class="kb-grid">${docs.map((d) => `<div class="kb-doc"><div class="row"><h4 class="grow">${esc(d.title)}</h4><button class="small ghost k-del" data-id="${d.id}">Delete</button></div>
    <div class="tags">${String(d.tags || '').split(',').map((t) => t.trim()).filter(Boolean).map((t) => `<span class="chip neutral">${esc(t)}</span>`).join('')}</div><p>${esc(d.content.slice(0, 260))}${d.content.length > 260 ? '…' : ''}</p></div>`).join('') || '<div class="card empty"><b>Empty</b>Add your first document.</div>'}</div>`;
  guarded($('#k-add'), async () => { await api('/kb', { method: 'POST', body: { title: $('#k-title').value, tags: $('#k-tags').value, content: $('#k-content').value } }); toast('Added'); go('kb'); });
  app.querySelectorAll('.k-del').forEach((b) => guarded(b, async () => { if (confirm('Delete this document?')) { await api('/kb/' + b.dataset.id, { method: 'DELETE' }); go('kb'); } }));
}

go('dashboard');