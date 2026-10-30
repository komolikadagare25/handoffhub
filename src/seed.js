const db = require('./db');
const { logger } = require('./logger');

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

// Realistic sample data so evaluators see a populated app on first load.
function seedIfEmpty() {
  if (process.env.SEED === 'false') return;
  if (db.prepare('SELECT COUNT(*) AS c FROM meetings').get().c > 0) return;

  const kb = db.prepare('INSERT INTO kb_docs (title, content, tags) VALUES (?,?,?)');
  kb.run('Payments Service Runbook', 'Runbook for the payments service: on-call rotation, rollback procedure, Razorpay webhook retries, database failover steps and incident severity levels. Deploys go through the staging environment first.', 'payments,runbook,oncall');
  kb.run('Q4 Release Plan', 'Release plan for Q4: feature freeze dates, QA sign-off checklist, release candidate process, app store submission and rollback plan for the mobile checkout redesign.', 'release,qa,planning');
  kb.run('Vendor Onboarding Policy', 'Policy for onboarding new vendors: security questionnaire, legal review, procurement approval and data-processing agreement requirements.', 'vendor,policy,legal');
  kb.run('Design System Guidelines', 'Guidelines for the design system: colour tokens, accessible components, typography scale and how to request new components from the design team.', 'design,ui,accessibility');

  const m = db.prepare('INSERT INTO meetings (title, type, status, agenda, participants, notes, summary, decisions, scheduled_at, prev_meeting_id) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const item = db.prepare('INSERT INTO action_items (meeting_id, title, owner, due_date, status, outcome, source) VALUES (?,?,?,?,?,?,?)');
  const hist = db.prepare('INSERT INTO item_history (item_id, event, detail) VALUES (?,?,?)');

  const m1 = Number(m.run('Q4 Mobile Release Sync — Week 1', 'meeting', 'completed',
    'Release readiness, payment webhook issues, QA capacity',
    JSON.stringify(['Aarav', 'Meera', 'Rohan', 'Sneha']),
    'Aarav: we need to finalize the release candidate. Meera will fix the webhook retry bug by Friday. Decided to freeze features on the 15th. Rohan to update the QA checklist. Sneha should talk to the vendor about the SMS gateway.',
    'Team reviewed release readiness for the Q4 mobile release. The webhook retry bug is the main blocker and the feature freeze date was fixed.',
    JSON.stringify(['Feature freeze on the 15th', 'Release candidate to go through staging first']), day(-8), null).lastInsertRowid);
  const a1 = Number(item.run(m1, 'Fix payment webhook retry bug', 'Meera', day(-3), 'open', '', 'manual').lastInsertRowid);
  const a2 = Number(item.run(m1, 'Update QA checklist for checkout redesign', 'Rohan', day(2), 'in_progress', '', 'manual').lastInsertRowid);
  const a3 = Number(item.run(m1, 'Confirm SMS gateway vendor contract terms', 'Sneha', day(-1), 'open', '', 'manual').lastInsertRowid);
  const a4 = Number(item.run(m1, 'Publish release timeline to stakeholders', 'Aarav', day(-6), 'done', 'Shared on Confluence and emailed to leadership.', 'manual').lastInsertRowid);
  [a1, a2, a3, a4].forEach((id) => hist.run(id, 'created', 'seed data'));
  hist.run(a4, 'closed', 'done: Shared on Confluence and emailed to leadership.');

  const m2 = Number(m.run('Q4 Mobile Release Sync — Week 2', 'meeting', 'scheduled',
    'Review carried-over items, go/no-go criteria',
    JSON.stringify(['Aarav', 'Meera', 'Rohan', 'Sneha']), '', '', '[]', day(1), m1).lastInsertRowid);
  const b1 = Number(item.run(m2, 'Fix payment webhook retry bug', 'Meera', day(-3), 'open', '', 'manual').lastInsertRowid);
  db.prepare("UPDATE action_items SET carried_from_id=? WHERE id=?").run(a1, b1);
  db.prepare("UPDATE action_items SET status='carried' WHERE id=?").run(a1);
  hist.run(a1, 'carried_forward', `to meeting ${m2} as item ${b1}`);
  hist.run(b1, 'created', `carried_from=${a1}`);
  const b2 = Number(item.run(m2, 'Prepare go/no-go checklist', '', day(3), 'open', '', 'manual').lastInsertRowid);
  hist.run(b2, 'created', 'unowned item for demo');

  logger.info({ event: 'seed_loaded', meetings: 2, kbDocs: 4 });
}

module.exports = { seedIfEmpty };
