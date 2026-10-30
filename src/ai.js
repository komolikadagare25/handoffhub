const { logger } = require('./logger');

class AIError extends Error {}

const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 20000);
// gemini-2.0-flash was shut down by Google in June 2026; keep these configurable via env.
const DEFAULT_MODEL = 'gemini-3.8-flash';
const DEFAULT_FALLBACK_MODEL = 'gemini-3.5-flash-lite';

/**
 * Single choke point for every LLM call.
 * - Provider: Google Gemini (REST). Key is read from env, sent in a header (never in URL/logs).
 * - Logs latency + outcome for each attempt.
 * - Throws AIError on failure; callers ALWAYS have a deterministic fallback.
 */
async function callModel(task, prompt, { json = true } = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    logger.warn({ event: 'ai_call', task, outcome: 'skipped', reason: 'GEMINI_API_KEY not set' });
    throw new AIError('AI not configured');
  }
  // Primary model first, then a backup model, so one retired/overloaded model does not break the app.
  const models = [...new Set([process.env.GEMINI_MODEL || DEFAULT_MODEL, process.env.GEMINI_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL])];
  let lastErr;

  for (let attempt = 1; attempt <= models.length; attempt++) {
    const model = models[attempt - 1];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, responseMimeType: json ? 'application/json' : 'text/plain' },
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        // Google's error body explains the cause (bad key, retired model, quota). It never contains our key.
        const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
        throw new Error(`HTTP ${res.status}: ${body}`);
      }
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('empty model response');
      const out = json ? parseJson(text) : text.trim();
      logger.info({ event: 'ai_call', task, model, attempt, latencyMs: Date.now() - started, outcome: 'success' });
      return out;
    } catch (e) {
      lastErr = e;
      const level = attempt === models.length ? 'error' : 'warn';
      logger[level]({
        event: 'ai_call', task, model, attempt, latencyMs: Date.now() - started, outcome: 'failure',
        error: e.name === 'AbortError' ? 'timeout' : e.message,
      });
    } finally {
      clearTimeout(timer);
    }
  }
  throw new AIError(`AI call failed: ${lastErr?.message}`);
}

function parseJson(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(cleaned);
}

const today = () => new Date().toISOString().slice(0, 10);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const str = (v) => (typeof v === 'string' ? v.trim() : '');

function matchParticipant(name, participants) {
  const n = str(name).toLowerCase();
  if (!n) return '';
  const hit = participants.find((p) => p.toLowerCase() === n) || participants.find((p) => p.toLowerCase().split(' ')[0] === n.split(' ')[0]);
  return hit || str(name);
}

// ---------- 1. Structured recap ----------
async function generateRecap(rawNotes, { title, participants = [] }) {
  const prompt = `You are an assistant that converts raw meeting notes / chats / emails into a structured recap.
Today's date is ${today()}. Meeting: "${title}". Known participants: ${JSON.stringify(participants)}.
Return ONLY JSON in this exact shape:
{"summary": string (2-4 sentences), "decisions": string[], "action_items": [{"title": string, "owner": string (one of the participants if possible, else ""), "due_date": "YYYY-MM-DD" or null}]}
Rules:
- Ignore filler words and small talk; write the summary as a clean professional recap, not a copy of the first lines.
- "decisions" = only FIRM decisions. Tentative ideas ("maybe", "probably", "let's wait") are NOT decisions; mention them in the summary instead.
- One action item per task, with a short imperative title (e.g. "Fix API 500 errors"). Split sentences that contain several tasks.
- "owner" = the person responsible, even if they are not in the participants list; "" if nobody is named.
- Resolve relative dates ("by Friday", "18 November") using today's date; use null if no deadline is stated.
- Do not invent items that are not in the text.

RAW INPUT:
"""
${rawNotes.slice(0, 12000)}
"""`;
  try {
    const raw = await callModel('recap', prompt);
    const result = {
      summary: str(raw.summary),
      decisions: Array.isArray(raw.decisions) ? raw.decisions.map(str).filter(Boolean) : [],
      action_items: (Array.isArray(raw.action_items) ? raw.action_items : [])
        .map((a) => ({
          title: str(a.title),
          owner: matchParticipant(a.owner, participants),
          due_date: isDate(a.due_date) ? a.due_date : null,
        }))
        .filter((a) => a.title),
    };
    if (!result.summary) throw new AIError('model returned no summary');
    return { ...result, ai_used: true, fallback: false };
  } catch (e) {
    logger.warn({ event: 'recap_fallback', reason: e.message });
    return { ...heuristicRecap(rawNotes, participants), ai_used: false, fallback: true, ai_error: String(e.message).slice(0, 200) };
  }
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const iso = (d) => d.toISOString().slice(0, 10);
function nextWeekday(name) {
  const target = WEEKDAYS.indexOf(name.toLowerCase());
  const d = new Date();
  let diff = (target - d.getDay() + 7) % 7;
  if (diff === 0) diff = 7;
  d.setDate(d.getDate() + diff);
  return iso(d);
}
function parseDue(sentence) {
  const isoM = sentence.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoM && isDate(isoM[1])) return isoM[1];
  const m = sentence.match(new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(' + MONTHS.join('|') + ')\\b', 'i'));
  if (m) {
    const now = new Date();
    let d = new Date(Date.UTC(now.getUTCFullYear(), MONTHS.indexOf(m[2].toLowerCase()), Number(m[1])));
    if (d < now) d = new Date(Date.UTC(now.getUTCFullYear() + 1, d.getUTCMonth(), d.getUTCDate()));
    return iso(d);
  }
  const wd = sentence.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  if (wd) return nextWeekday(wd[1]);
  if (/\btoday\b/i.test(sentence)) return iso(new Date());
  return null;
}

const NOT_NAMES = new Set('also okay one maybe coming oh please marketing testing the we they this that it but so and finance he she i then now next after before first second however meeting decisions summary action'.split(' '));
function findOwner(sentence, participants) {
  const known = participants.find((p) => new RegExp('\\b' + p.split(' ')[0] + '\\b', 'i').test(sentence));
  if (known) return known;
  const re = /\b([A-Z][a-z]{2,})\b(?=\s+(?:will|needs? to|should|has to|must|is going to|to)\b)/g;
  let m;
  while ((m = re.exec(sentence))) if (!NOT_NAMES.has(m[1].toLowerCase())) return m[1];
  return '';
}

const TENTATIVE = /\b(maybe|probably|not sure|might|let's not|not finali[sz]ed|i think)\b/i;
const ACTION_VERB = /\b(will|needs? to|should|has to|must|is going to)\b/i;
const PASSIVE_TODO = /\b(should|must|need(?:s)? to)(?: also)? be (fixed|done|completed|resolved|reviewed)\b/i;
const DECISION = /\b(decid\w*|agreed?|approved|finali[sz]ed|resolved|not necessary|consider it in version|will not|won't)\b/i;

// Deterministic fallback so the app keeps working when the AI is down.
function heuristicRecap(raw, participants) {
  const clean = raw
    .replace(/^#+\s.*$/gm, ' ')
    .replace(/\b(umm+|uh+|you know|okay,? so|honestly|basically)\b[,]?\s*/gi, '')
    .replace(/\s+/g, ' ');
  const sentences = clean.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length > 12);

  const decisions = sentences.filter((x) => DECISION.test(x) && !TENTATIVE.test(x));
  const actions = [];
  for (const x of sentences) {
    if (decisions.includes(x)) continue;
    const owner = findOwner(x, participants);
    if ((owner && ACTION_VERB.test(x)) || PASSIVE_TODO.test(x)) {
      actions.push({ title: x.replace(/^(and|also|but|so|then)\s+/i, '').slice(0, 160), owner, due_date: parseDue(x) });
    }
  }
  const KEY = /\b(delay\w*|launch|decid\w*|approved|budget|issue|bug|blocker|deadline|release|plan\w*)\b/i;
  const pick = sentences.filter((x) => KEY.test(x) && !/\b(late|let's start|join)\b/i.test(x)).slice(0, 3);
  const summary = (pick.length ? pick : sentences.slice(0, 3)).join(' ');
  return { summary: summary || 'No summary available.', decisions, action_items: actions };
}

// ---------- 2. Catch-up brief ----------
async function generateCatchup(ctx) {
  const prompt = `Write a SHORT catch-up brief for ${ctx.person || 'someone who missed this meeting / is taking over'}.
Today is ${today()}. Return ONLY JSON:
{"brief": string (max 5 sentences), "key_decisions": string[], "your_actions": string[], "risks": string[]}
"your_actions" = open items owned by ${ctx.person || 'the reader'}; if no person, list the most urgent open items. "risks" = overdue or unowned items.

CONTEXT (JSON):
${JSON.stringify(ctx).slice(0, 12000)}`;
  try {
    const raw = await callModel('catchup', prompt);
    if (!str(raw.brief)) throw new AIError('empty brief');
    return {
      brief: str(raw.brief),
      key_decisions: (raw.key_decisions || []).map(str).filter(Boolean),
      your_actions: (raw.your_actions || []).map(str).filter(Boolean),
      risks: (raw.risks || []).map(str).filter(Boolean),
      ai_used: true, fallback: false,
    };
  } catch (e) {
    logger.warn({ event: 'catchup_fallback', reason: e.message });
    const mine = ctx.open_items.filter((i) => !ctx.person || i.owner === ctx.person);
    return {
      brief: `${ctx.meeting.title}: ${ctx.meeting.summary || 'no summary recorded yet.'} There are ${ctx.open_items.length} open item(s).`,
      key_decisions: ctx.meeting.decisions,
      your_actions: mine.map((i) => `${i.title}${i.due_date ? ` (due ${i.due_date})` : ''}`),
      risks: ctx.open_items.filter((i) => !i.owner || (i.due_date && i.due_date < today())).map((i) => `${i.title}${i.owner ? '' : ' (no owner)'}${i.due_date && i.due_date < today() ? ' (overdue)' : ''}`),
      ai_used: false, fallback: true,
    };
  }
}

// ---------- 3. Knowledge-base linking ----------
const STOP = new Set('the a an and or of to in on for with is are be this that it as at by from we will our your you not but have has had'.split(' '));
const tokens = (s) => (s.toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((w) => !STOP.has(w));

function keywordLinks(text, docs) {
  const q = new Set(tokens(text));
  return docs
    .map((d) => {
      const dt = new Set(tokens(`${d.title} ${d.tags} ${d.content}`));
      let overlap = 0;
      q.forEach((w) => dt.has(w) && overlap++);
      return { doc_id: d.id, title: d.title, score: +(overlap / Math.sqrt(q.size * dt.size || 1)).toFixed(3), reason: 'keyword overlap' };
    })
    .filter((l) => l.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

async function linkKnowledge(meeting, docs) {
  const text = `${meeting.title}\n${meeting.agenda}\n${meeting.summary}\n${meeting.decisions.join('\n')}\n${meeting.notes}`;
  if (!docs.length) return { links: [], ai_used: false, fallback: false };
  const catalog = docs.map((d) => ({ id: d.id, title: d.title, tags: d.tags, excerpt: d.content.slice(0, 400) }));
  const prompt = `Pick the knowledge-base documents most relevant to this meeting (max 3, only if genuinely relevant).
Return ONLY JSON: {"links":[{"doc_id": number, "reason": string (one short sentence), "score": number 0-1}]}

MEETING:
${text.slice(0, 5000)}

DOCUMENTS:
${JSON.stringify(catalog)}`;
  try {
    const raw = await callModel('kb_link', prompt);
    const ids = new Set(docs.map((d) => d.id));
    const links = (raw.links || [])
      .filter((l) => ids.has(Number(l.doc_id)))
      .map((l) => ({ doc_id: Number(l.doc_id), title: docs.find((d) => d.id === Number(l.doc_id)).title, reason: str(l.reason) || 'relevant', score: Math.min(1, Math.max(0, Number(l.score) || 0.5)) }))
      .slice(0, 3);
    return { links, ai_used: true, fallback: false };
  } catch (e) {
    logger.warn({ event: 'kb_link_fallback', reason: e.message });
    return { links: keywordLinks(text, docs), ai_used: false, fallback: true };
  }
}

// ---------- 4. Special feature: nudge drafting ----------
async function draftNudge(item, ctx) {
  const prompt = `Draft a short, friendly, specific follow-up message (max 60 words, no greeting fluff) from a team lead to ${item.owner || 'the team'} about this action item.
Today is ${today()}. Return ONLY JSON: {"message": string}
Item: ${JSON.stringify({ title: item.title, due_date: item.due_date, status: item.status })}
Context: from meeting "${ctx.meetingTitle}"; days overdue: ${ctx.daysOverdue}; times carried forward: ${ctx.carries}.`;
  try {
    const raw = await callModel('nudge', prompt);
    if (!str(raw.message)) throw new AIError('empty message');
    return { message: str(raw.message), ai_used: true, fallback: false };
  } catch (e) {
    logger.warn({ event: 'nudge_fallback', reason: e.message });
    const od = ctx.daysOverdue > 0 ? ` It was due ${item.due_date} (${ctx.daysOverdue} day(s) ago).` : item.due_date ? ` It is due ${item.due_date}.` : '';
    return { message: `Hi ${item.owner || 'there'}, quick check-in on "${item.title}" from "${ctx.meetingTitle}".${od} Can you share a status or let me know if you're blocked?`, ai_used: false, fallback: true };
  }
}

// ---------- 5. Handover pack narrative ----------
// The model only writes prose. Facts (items, dates, links) are assembled in handover.js; whatever the model returns is
// validated against that data (unknown meeting ids / people are dropped) and merged over the deterministic fallback.
async function generateHandover(ctx, fallback, { meetingIds, candidateNames }) {
  const prompt = `You are writing a HANDOVER DOCUMENT so that a colleague can cover for ${ctx.person}${ctx.back_on ? ` until ${ctx.back_on}` : ''}${ctx.covering ? ` (covering: ${ctx.covering})` : ''}.
Today is ${ctx.today}. Use ONLY the facts in CONTEXT. Never invent names, dates, decisions or meetings.
Return ONLY JSON in this exact shape:
{"overview": string (3-5 sentences: what ${ctx.person} is responsible for, what is most urgent, what the cover should do first),
 "meetings": [{"meeting_id": number (from CONTEXT), "context": string (2-3 sentences: why this work exists, what was decided, where it stands now), "first_steps": string[] (1-3 concrete actions for the cover, most urgent first)}],
 "risks": string[] (max 5; specific, naming the item and why it is risky; base them on known_risks and the items),
 "who_to_ask": [{"name": string (MUST be one of people_who_know_this), "ask_about": string (what that person can help with)}]}
Write plainly for someone who was NOT in the meetings. Mention overdue or repeatedly-carried items explicitly.

CONTEXT (JSON):
${JSON.stringify(ctx).slice(0, 14000)}`;
  try {
    const raw = await callModel('handover', prompt);
    const out = { ...fallback, meetings: { ...fallback.meetings } };
    if (str(raw.overview)) out.overview = str(raw.overview);
    for (const m of Array.isArray(raw.meetings) ? raw.meetings : []) {
      const id = Number(m.meeting_id);
      if (!meetingIds.includes(id)) continue; // hallucinated meeting
      const steps = (Array.isArray(m.first_steps) ? m.first_steps : []).map(str).filter(Boolean).slice(0, 4);
      out.meetings[id] = { context: str(m.context) || fallback.meetings[id].context, first_steps: steps.length ? steps : fallback.meetings[id].first_steps };
    }
    const risks = (Array.isArray(raw.risks) ? raw.risks : []).map(str).filter(Boolean).slice(0, 6);
    if (risks.length) out.risks = risks;
    const known = new Map(candidateNames.map((n) => [n.toLowerCase(), n]));
    const who = (Array.isArray(raw.who_to_ask) ? raw.who_to_ask : [])
      .filter((w) => known.has(str(w.name).toLowerCase())) // hallucinated person
      .map((w) => ({ name: known.get(str(w.name).toLowerCase()), ask_about: str(w.ask_about) || 'context on this work' }));
    if (who.length) out.who_to_ask = who.slice(0, 5);
    if (!str(raw.overview)) throw new AIError('model returned no overview');
    return { narrative: out, ai_used: true, fallback: false };
  } catch (e) {
    logger.warn({ event: 'handover_fallback', reason: e.message });
    return { narrative: fallback, ai_used: false, fallback: true, ai_error: String(e.message).slice(0, 200) };
  }
}

module.exports = { generateRecap, generateCatchup, linkKnowledge, draftNudge, generateHandover, AIError };