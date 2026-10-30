# HandoffHub — AI-Powered Knowledge & Task Management Platform

Teams lose context whenever work changes hands. HandoffHub captures meetings and work transfers, turns messy notes into structured recaps, tracks every action item until it is closed, carries open items forward with full history, and gives anyone who missed a meeting (or is taking over) a short AI catch-up brief.

**Live demo:** `<add your deployed URL>` · **Repo:** `<add your GitHub URL>`

## Features (mapped to the brief)

| Requirement | Where |
|---|---|
| Create/persist meetings & work transfers (agenda, participants, notes, decisions, items) | `POST /api/meetings`, SQLite |
| Lifecycle + action-item tracking (owner, due, status) | `PUT /api/meetings/:id`, `PATCH /api/items/:id` |
| Carry open items forward, keep history | `POST /api/meetings/:id/carry-forward`, `GET /api/items/:id/history` |
| AI: raw text → summary, decisions, items, owners | `POST /api/meetings/:id/recap` |
| AI: catch-up brief | `GET /api/meetings/:id/catchup?person=` |
| Knowledge base + AI linking | `/api/kb`, `POST /api/meetings/:id/link-kb` |
| Record outcome of each item | `POST /api/items/:id/close` (outcome required) |
| Validation & error handling | Input checks on every endpoint, consistent JSON errors |
| Structured logging | `src/logger.js` → `logs/app.log` |
| Special feature | **Handoff Radar** (below) |

## Run locally

```bash
npm install
cp .env.example .env      # add GEMINI_API_KEY (optional – app works without it)
npm start                 # http://localhost:3000
npm test                  # end-to-end smoke test (no API key needed)
```
Node 22.13+ required (uses the built-in SQLite module, so `npm install` needs no C++ build tools).

## AI configuration

- **Provider/model:** Google Gemini via REST (`GEMINI_MODEL`, default `gemini-2.0-flash`). Get a free key at aistudio.google.com/apikey and set `GEMINI_API_KEY`.
- **Data flow:** only the text needed for a task (notes, titles, item lists, KB excerpts) is sent. The key is sent in a header, never in a URL, and is redacted from logs.
- **Structured output:** prompts request strict JSON (`responseMimeType: application/json`); responses are parsed and **re-validated** (dates checked, owners matched to participants, KB ids verified against the DB) before anything is saved, so hallucinated ids/dates are dropped.
- **Failure handling:** 20 s timeout, 1 retry, then a **deterministic fallback** for every AI feature (rule-based recap, templated brief, keyword/TF overlap KB linking, templated nudge). The UI shows a "fallback (AI unavailable)" badge so users know.

| Task | Prompt purpose | Fallback |
|---|---|---|
| `recap` | Notes → summary/decisions/items | Regex heuristics (decision words, "will/needs to", names, weekdays, ISO dates) |
| `catchup` | Short brief for a person | Template from stored data |
| `kb_link` | Pick relevant docs + reason | Keyword overlap score |
| `nudge` | Draft follow-up message | Template |

## Data source

SQLite (Node built-in `node:sqlite`, WAL mode, no native build step) with tables `meetings`, `action_items`, `item_history`, `kb_docs`. On first start, `src/seed.js` loads realistic sample data (a two-week release-sync chain with an overdue item, an unowned item, a carried-forward item, and 4 KB docs). Set `SEED=false` to start empty. Carried items keep a `carried_from_id` link, so one item's full history across meetings can be reconstructed.

## Logging

- `pino`, JSON lines, written to **stdout and `logs/app.log`** (`LOG_DIR`, `LOG_LEVEL`).
- A **correlation ID** per request (accepts incoming `x-request-id`, else generates a UUID, returned in the response header) is attached to *every* log line in that request via `AsyncLocalStorage`.
- Key events: `meeting_created`, `item_created`, `item_reassigned`, `item_status_changed`, `item_closed`, `items_carried_forward`, `bulk_reassigned`, `kb_linked`, `server_started`.
- AI calls: `event=ai_call` with `task`, `model`, `attempt`, `latencyMs`, `outcome` (`success` / `failure` / `skipped`).
- Errors: `unhandled_error` with path, method and stack; clients get only `{error, requestId}` so a support person can grep the ID.
- No secrets: API key is read from env only and `redact` censors key-like fields.

## Special feature: Handoff Radar + AI nudges

Most tools list tasks; they don't tell you **which context is about to be lost**. Radar scores every open item for "falls-through-the-cracks" risk:

`risk = overdue (3 + 0.3/day, capped) + due within 3 days (1) + 1.5 × times carried forward + no owner (2) + no due date (0.5)`

It ranks people and items, and each item has a **Nudge** button where AI drafts a specific follow-up using overdue days and carry count. A **bulk reassign** ("cover for someone on leave") moves all of a person's open items to a colleague and writes a history entry on each. This directly targets the brief's failure modes: an unanswered invite, a colleague on leave, and an action item that quietly dies after being carried over repeatedly.

## Approach & architecture

Express 5 JSON API + a dependency-free vanilla-JS single-page UI served from `/public` — one process, one deploy. SQLite keeps setup trivial. All LLM access goes through one function (`callModel`) so logging, timeouts, retries and key handling live in one place. Multi-row changes (recap apply, carry-forward, bulk reassign) run in DB transactions.

## Deployment

**Render (free):** push to GitHub → New → Blueprint (uses `render.yaml`) → set `GEMINI_API_KEY` → deploy. Health check: `/api/health`.
Docker: `docker build -t handoffhub . && docker run -p 3000:3000 -e GEMINI_API_KEY=... -v hh:/data handoffhub`.

## Assumptions & known limitations

- No authentication / multi-tenancy: "owner" and "participants" are free-text names (would be users + SSO in production).
- Free hosting has an ephemeral disk, so data resets on restart unless a persistent disk is attached (seed data reloads).
- Notifications are drafted, not sent (no email/Slack integration); no audio transcription (paste a transcript).
- Relative dates like "Friday" in fallback mode resolve to the *next* such weekday.
- KB linking sends excerpts, not embeddings; fine for small KBs, would need a vector index at scale.
- Smoke test covers the API with fallbacks; AI-path behaviour depends on a live key.