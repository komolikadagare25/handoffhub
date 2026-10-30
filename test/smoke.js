// End-to-end smoke test. Runs with a throwaway DB and NO AI key, so it also proves the fallback paths work.
process.env.DB_PATH = require('path').join(require('os').tmpdir(), `handoffhub-test-${Date.now()}.db`);
process.env.LOG_DIR = require('path').join(require('os').tmpdir(), `handoffhub-logs-${Date.now()}`);
process.env.SEED = 'false';
process.env.GEMINI_API_KEY = ''; 
process.env.DOTENV_CONFIG_QUIET = 'true';

const assert = require('assert');
const app = require('../src/server');

const server = app.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api`;
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: r.status === 204 ? null : await r.json(), reqId: r.headers.get('x-request-id') };
  };
  try {
    let r = await call('POST', '/meetings', { title: '' });
    assert.strictEqual(r.status, 400, 'empty title rejected');
    assert.ok(r.reqId, 'request id header present');

    r = await call('POST', '/meetings', { title: 'Sprint sync', participants: ['Asha', 'Ravi'], agenda: 'Release' });
    assert.strictEqual(r.status, 201); const mid = r.body.id;

    r = await call('POST', `/meetings/${mid}/recap`, { notes: 'We agreed to ship on 2030-01-10.\nAsha will fix the login bug by 2030-01-05.\nRavi needs to update the docs by friday.' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.fallback, true, 'fallback used without AI key');
    assert.ok(r.body.created_item_ids.length >= 2, 'items extracted by fallback');

    r = await call('GET', `/meetings/${mid}`);
    const item = r.body.items.find((i) => i.owner === 'Asha');
    assert.ok(item, 'owner detected');

    r = await call('POST', `/items/${item.id}/close`, {});
    assert.strictEqual(r.status, 400, 'outcome required to close');
    r = await call('POST', `/items/${item.id}/close`, { outcome: 'Fixed in PR #12' });
    assert.strictEqual(r.body.status, 'done');
    r = await call('POST', `/items/${item.id}/close`, { outcome: 'again' });
    assert.strictEqual(r.status, 409, 'cannot close twice');

    r = await call('POST', `/meetings/${mid}/carry-forward`, {});
    assert.strictEqual(r.status, 201);
    assert.ok(r.body.carried >= 1);
    const nextId = r.body.meeting.id;

    r = await call('GET', `/meetings/${nextId}`);
    const carried = r.body.items[0];
    r = await call('GET', `/items/${carried.id}/history`);
    assert.ok(r.body.chain.length === 2, 'history follows chain');

    r = await call('POST', '/items/reassign', { from: 'Ravi', to: 'Asha' });
    assert.strictEqual(r.status, 200);

    r = await call('GET', `/meetings/${nextId}/catchup?person=Asha`);
    assert.strictEqual(r.status, 200); assert.ok(r.body.brief);

    r = await call('POST', '/kb', { title: 'Login service guide', content: 'How the login bug fix process and release docs work', tags: 'login' });
    assert.strictEqual(r.status, 201);
    r = await call('POST', `/meetings/${mid}/link-kb`);
    assert.ok(r.body.links.length >= 1, 'keyword fallback links KB');

    r = await call('GET', '/radar');
    assert.ok(Array.isArray(r.body.people));
    r = await call('GET', '/meetings/9999');
    assert.strictEqual(r.status, 404);

    // ---------- review-before-save: preview must NOT write anything ----------
    r = await call('POST', '/meetings', { title: 'Review demo', participants: ['Asha', 'Ravi'] });
    const rid = r.body.id;
    r = await call('POST', `/meetings/${rid}/recap/preview`, { notes: 'We decided to use Postgres for the report store.\nAsha will ship the report by 2020-01-01.' });
    assert.strictEqual(r.status, 200); assert.ok(r.body.action_items.length >= 1, 'preview returns items');
    r = await call('GET', `/meetings/${rid}`);
    assert.strictEqual(r.body.items.length, 0, 'preview saved no items');
    assert.strictEqual(r.body.summary, '', 'preview saved no summary');

    r = await call('POST', `/meetings/${rid}/recap/apply`, { summary: '', action_items: [] });
    assert.strictEqual(r.status, 400, 'apply needs a summary');
    r = await call('POST', `/meetings/${rid}/recap/apply`, { summary: 'x', action_items: [{ title: 'Bad', due_date: 'tomorrow' }] });
    assert.strictEqual(r.status, 400, 'apply validates dates');
    r = await call('GET', `/meetings/${rid}`);
    assert.strictEqual(r.body.items.length, 0, 'rejected apply saved nothing');
    r = await call('POST', `/meetings/${rid}/recap/apply`, {
      notes: 'raw', summary: 'Edited by a human.', decisions: ['Use Postgres'], ai_used: false,
      action_items: [{ title: 'Ship the report', owner: 'Asha', due_date: '2020-01-01' }, { title: '   ' }],
    });
    assert.strictEqual(r.status, 201); assert.strictEqual(r.body.created_item_ids.length, 1, 'blank rows dropped');
    assert.strictEqual(r.body.meeting.summary, 'Edited by a human.', 'edited text is what gets saved');
    const shipId = r.body.created_item_ids[0];

    // ---------- board moves (status rules still enforced) ----------
    r = await call('PATCH', `/items/${shipId}`, { status: 'in_progress' }); assert.strictEqual(r.status, 200);
    r = await call('PATCH', `/items/${shipId}`, { status: 'done' }); assert.strictEqual(r.status, 400, 'cannot drag to done without outcome');
    r = await call('POST', `/items/${shipId}/close`, { outcome: 'Shipped' }); assert.strictEqual(r.body.status, 'done');
    r = await call('PATCH', `/items/${shipId}`, { status: 'open' }); assert.strictEqual(r.body.status, 'open', 'reopen from done works');

    // ---------- dashboard ----------
    r = await call('GET', '/stats');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.items.overdue >= 1, 'overdue counted'); assert.ok(r.body.items.done_this_week >= 1, 'closed this week counted');
    assert.ok(Array.isArray(r.body.top_risks) && Array.isArray(r.body.workload) && Array.isArray(r.body.activity));
    r = await call('GET', '/people'); assert.ok(r.body.includes('Asha'));

    // ---------- handover pack (fallback path) ----------
    r = await call('GET', '/handover'); assert.strictEqual(r.status, 400, 'from required');
    r = await call('GET', '/handover?from=Asha&to=Asha'); assert.strictEqual(r.status, 400, 'cannot hand over to self');
    r = await call('GET', '/handover?from=Nobody'); assert.strictEqual(r.body.empty, true, 'empty pack handled');
    r = await call('GET', '/handover?from=Asha&to=Ravi&until=2030-02-01');
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.fallback, true);
    assert.ok(r.body.markdown.startsWith('# Handover pack: Asha → Ravi'));
    assert.ok(r.body.markdown.includes('Ship the report') && r.body.markdown.includes('overdue'), 'items and risks present');
    assert.ok(r.body.markdown.includes('Review demo'), 'grouped by meeting');
    assert.ok(r.body.data.candidates.every((c) => c.name !== 'Asha' && c.name !== 'Ravi'), 'person and cover excluded from who-to-ask');
    const dl = await fetch(`${base}/handover?from=Asha&format=md`);
    assert.ok((dl.headers.get('content-disposition') || '').includes('handover-asha-'), 'markdown download header');

    // ---------- handover pack (AI path with a model that hallucinates) ----------
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => (String(url).includes('generativelanguage')
      ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        overview: 'AI overview.',
        meetings: [{ meeting_id: rid, context: 'AI context for review demo.', first_steps: ['AI step one'] }, { meeting_id: 9999, context: 'GHOSTMEETING', first_steps: ['no'] }],
        risks: ['AI risk line'],
        who_to_ask: [{ name: 'ravi', ask_about: 'the report store' }, { name: 'Ghost Person', ask_about: 'nothing' }],
      }) }] } }] }), { status: 200 })
      : realFetch(url, opts));
    process.env.GEMINI_API_KEY = 'test-key';
    try { r = await call('GET', '/handover?from=Asha'); } finally { global.fetch = realFetch; delete process.env.GEMINI_API_KEY; }
    assert.strictEqual(r.body.ai_used, true);
    assert.ok(r.body.markdown.includes('AI overview.') && r.body.markdown.includes('AI context for review demo.'), 'valid AI prose used');
    assert.ok(!r.body.markdown.includes('GHOSTMEETING'), 'hallucinated meeting dropped');
    assert.ok(!r.body.markdown.includes('Ghost Person'), 'hallucinated person dropped');
    assert.ok(r.body.markdown.includes('**Ravi**'), 'real person kept with canonical name');
    assert.ok(r.body.markdown.includes('Sprint sync'), 'meetings the AI skipped are filled from the fallback');

    console.log('All smoke tests passed ✅');
    server.close(); process.exit(0);
  } catch (e) {
    console.error('TEST FAILED:', e.message); server.close(); process.exit(1);
  }
});
