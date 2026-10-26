# Status

Honest state per capability. Goal-level coverage per persona: docs/GOAL-COVERAGE.md. "Tested" means an automated test with real Postgres and fake external systems.
"Live-verified" means checked against the real platform; nothing is live-verified yet.

| Capability | State | Evidence |
|---|---|---|
| Webhook signature, size limit, handshake, foreign number filter | Tested | F17, F18, F19, T-HTTP-01 |
| Inbound dedupe, unknown sender once/day, rate limit 30/min | Tested | F1, F20, F21 |
| Self sign-up for first-time users (own workspace as owner, daily cap) | Tested | T-SIGNUP-01, T-SIGNUP-02 |
| Roles: owner/editor/viewer; owner-only approvals and commands | Tested | F6, T-CMD-03, T-CMD-04 |
| Onboarding (6 questions, resumable) → profile + owner memory | Tested | T-CMD-01 |
| Media ingest, checksum storage, ffprobe QC, reshoot on bad file | Tested | T-UNIT-10 |
| Caption skill (cache, budget, usage, schema validation, retry) | Tested with fake model | T-COST-01, F22 |
| Claim and banned-phrase highlighting on the approval card | Tested | T-UNIT-08, F29 |
| Consent question for every workspace kind; re-check at publish | Tested | F3, F4 |
| Approval hash over full payload; one pending per task; expiry | Tested | F2, F5, F7, F8, T-UNIT-02 |
| Routing E/A/N per account type; assisted package | Tested | T-POST-03, T-UNIT-13 |
| Publish via ledger; reconcile; readback with caption match | Tested with fake platform | F9–F13, F12b |
| 24h window; held approval cards re-sent when owner writes | Tested | F16, T-CMD-04 |
| Token expiry → reconnect link; health checks | Tested | F25, T-SCH-02 |
| Report and weekly digest from platform numbers only | Tested | T-CMD-02, T-SCH-01 |
| Pause/resume, forget, export (one-time link), delete with cooling period | Tested | T-CMD-06..08, F30, F31 |
| RLS isolation and coverage; append-only audit for app role | Tested | F32, T-DB-01..03 |
| Operator API (stuck tasks, retry with new approval, replay dead jobs, pause) | Tested | T-HTTP-03..05 |
| Web chat (MODE=web): signed session cookie, text, buttons, photo/video upload | Tested; booted for real in web mode | T-WEB-01, T-WEB-02 |
| WhatsApp Cloud API adapter | Code + mocked-network tests only | T-ADP-01, T-ADP-02 |
| Meta Instagram/Facebook publish adapter | Code + mocked-network tests only; OFF by default | T-ADP-03..05 |
| Meta login (OAuth) for Pages + linked Instagram | Code only, untested | — |
| "connect" → account info (name, bio, followers, recent posts) via official API | Tested with fake platform; Meta fields UNVERIFIED | L-01..L-03 |
| Pasted link → public info: Instagram Business Discovery, Facebook Page metadata, YouTube Data API; never scraped | Tested with mocked network; real APIs UNVERIFIED (need credentials) | T-LINK-01..07 |
| Conversational onboarding and chat with Claude (history, kind switch with consent) | Tested with a stubbed model; real Claude used manually by the owner | O-01, O-02, T-CHAT-01..04 |
| Claude adapter | Code only; needs key and budget | eval runner |

## Known gaps (not built)
- WhatsApp message templates for reaching an owner outside the 24h window (cards wait until the owner writes).
- Delivery-status driven fallback beyond recording status.
- Ads, comments/DMs, leads, scheduling calendar, media editing, browser route, second platform, billing.
- Live evals: `npm run eval` with the fake model scores 47% intent / 90% caption, which only shows the evals catch weak output. A real model run needs `ANTHROPIC_API_KEY`.
- Load test, backup/restore drill, metrics/alerting beyond structured logs.

## Live checks still to run (docs/RUNBOOK.md)
L1 webhook verification · L2 reply on a real phone · L3 buttons · L4 media download · L5 Instagram publish + readback on your own account · L6 FB Page publish · L7 revoked token → reconnect · L8 closed window → blocked.
