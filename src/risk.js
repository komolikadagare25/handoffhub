// Single source of truth for "how likely is this item to fall through the cracks".
// Used by the Radar, the Dashboard and the Handover Pack so the numbers always agree.
const db = require('./db');

const todayStr = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.floor((Date.parse(b) - Date.parse(a)) / 86400000);
const plusDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

// How many times has this item been carried forward from an earlier meeting?
function carriesOf(id) {
  let n = 0;
  let cur = db.prepare('SELECT carried_from_id FROM action_items WHERE id=?').get(id);
  while (cur && cur.carried_from_id && n < 50) {
    n++;
    cur = db.prepare('SELECT carried_from_id FROM action_items WHERE id=?').get(cur.carried_from_id);
  }
  return n;
}

// risk = overdue (3 + 0.3/day, capped) + due within 3 days (1) + 1.5 x carries + no owner (2) + no due date (0.5)
function scoreItem(i) {
  const t = todayStr();
  const soon = plusDays(3);
  const overdueDays = i.due_date && i.due_date < t ? daysBetween(i.due_date, t) : 0;
  const dueSoon = !!(i.due_date && i.due_date >= t && i.due_date <= soon);
  const carries = carriesOf(i.id);
  const risk = (overdueDays ? 3 + Math.min(overdueDays, 10) * 0.3 : 0) + (dueSoon ? 1 : 0) + carries * 1.5 + (i.owner ? 0 : 2) + (i.due_date ? 0 : 0.5);
  return { overdueDays, dueSoon, carries, risk: +risk.toFixed(1) };
}

module.exports = { todayStr, daysBetween, plusDays, carriesOf, scoreItem };
