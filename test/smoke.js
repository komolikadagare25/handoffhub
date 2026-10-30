// End-to-end smoke test. Runs with a throwaway DB and NO AI key, so it also proves the fallback paths work.
process.env.DB_PATH = require('path').join(require('os').tmpdir(), `handoffhub-test-${Date.now()}.db`);
process.env.LOG_DIR = require('path').join(require('os').tmpdir(), `handoffhub-logs-${Date.now()}`);
process.env.SEED = 'false';
delete process.env.GEMINI_API_KEY;
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

    console.log('All smoke tests passed ✅');
    server.close(); process.exit(0);
  } catch (e) {
    console.error('TEST FAILED:', e.message); server.close(); process.exit(1);
  }
});
