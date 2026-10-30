# 3.5-hour execution plan (what to do in the assessment)

| Time | Block | Deliverable |
|---|---|---|
| 0:00–0:15 | Read brief, decide stack, write 5-line architecture + the special feature | Notes you will paste into README |
| 0:15–0:30 | Repo + scaffold: `npm init`, Express, SQLite schema, logger, `.env.example`, `.gitignore`, first commit + push | GitHub repo live |
| 0:30–1:15 | Core CRUD: meetings, action items, validation, error handler, request-ID middleware | Working API (test with curl) |
| 1:15–1:55 | AI layer: single `callModel`, recap, catch-up, KB linking, **fallbacks** | AI features working + failing gracefully |
| 1:55–2:20 | Lifecycle: carry-forward with history, close with outcome, bulk reassign | Core story end-to-end |
| 2:20–2:40 | Special feature (Radar + nudge) | Feature demo-able |
| 2:40–3:05 | Frontend wiring + polish; seed data | Usable UI |
| 3:05–3:25 | Deploy (Render), set env vars, test live URL | Public URL |
| 3:25–3:35 | README (AI config, data, logging, feature, assumptions, limitations), final push | Submission |

Rules of thumb: commit every ~30 min; deploy an empty "hello" app at ~0:30 if you're nervous, so the last 20 minutes are never the first deploy; cut UI polish before cutting logging/README.

# Git + deploy steps

```bash
git init && git add . && git commit -m "feat: HandoffHub initial"
# create an empty repo on github.com (no README), then:
git branch -M main
git remote add origin https://github.com/<you>/handoffhub.git
git push -u origin main
```
Render: New → Blueprint → pick repo → add `GEMINI_API_KEY` → Deploy. Paste the live URL + repo URL into the README.

# Viva cheat-sheet

- Why SQLite? Zero-ops, transactional, enough for scope; swap to Postgres by replacing `db.js`.
- Why fallbacks? The brief says "handle AI failures gracefully" — every AI feature has a deterministic path and the UI labels it.
- How do you trust AI output? JSON mode + server-side validation (dates, owners, KB ids) before persisting.
- Traceability? One request ID on every log line, returned in the response header.
- Weakness to admit: no auth, ephemeral free-tier disk.
