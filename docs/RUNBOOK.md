# Runbook

## Web chat (MODE=web)
1. `.env`: `ANTHROPIC_API_KEY`, `AI_DAILY_BUDGET_INR`; optional lookup and Meta credentials (see README table).
2. `npm run dev`, open `http://localhost:8080/`. For other people or for publishing, expose it with
   `cloudflared tunnel --url http://localhost:8080` and set `PUBLIC_BASE_URL` to the tunnel's https URL.
3. Each new browser signs up as the owner of its own workspace; `SIGNUPS_PER_DAY` caps abuse. Set `SELF_SIGNUP=false`
   to allow only workspaces created through the operator API.

## Going live on WhatsApp, step by step
1. `cp .env.example .env`; set strong `DB_ROLE_PASSWORD`, `CREDENTIAL_KEY`, `LINK_SECRET`, `OPERATOR_TOKEN`.
2. `npm run db:setup` against your Postgres (admin URL in `DATABASE_URL`).
3. Meta for Developers: create a Business app, add WhatsApp, use the test number, add your phone as a recipient.
   Fill `WA_*`. Set `MODE=live`, `LLM_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, `AI_DAILY_BUDGET_INR` (e.g. 50),
   and keep `META_PUBLISH_ENABLED=false` for now.
4. `npm run doctor`, then `npm start`; expose with `cloudflared tunnel --url http://localhost:8080`.
5. In the Meta app, set the webhook to `https://<tunnel>/webhook` with `WA_VERIFY_TOKEN`; subscribe to `messages`.
6. Create your workspace: `curl -XPOST localhost:8080/ops/workspaces -H "authorization: Bearer $OPERATOR_TOKEN" -H 'content-type: application/json' -d '{"name":"My Shop","kind":"business","ownerPhone":"91XXXXXXXXXX"}'`
7. Run live checks L1–L4 and L8 from your phone (nothing is published while META_PUBLISH_ENABLED=false).
8. For publishing: set `META_APP_ID/SECRET`, add the redirect `https://<host>/connect/meta/callback`,
   send "connect" in WhatsApp, log in with an account that manages your Page and linked Instagram professional account.
9. Set `META_PUBLISH_ENABLED=true` only for check L5 on your own account; confirm one post, readback, no duplicate.

## Live checks
| Check | Pass when |
|---|---|
| L1 | Meta dashboard verifies the webhook |
| L2 | "help" from your phone gets the help reply |
| L3 | Approval buttons arrive and a tap changes the task |
| L4 | A video you send is stored with a checksum and passes QC |
| L5 | One Instagram post published on your own account, read back, link sent; forced retry creates no second post |
| L6 | Same for a Facebook Page |
| L7 | Revoking the app's access produces one reconnect link, no crash loop |
| L8 | A message to a phone silent for 24h+ is recorded as blocked_window and not sent |

## Operations
- Stuck posts: `GET /ops/tasks?state=needs_human`. Check the platform; then `POST /ops/tasks/:id/resolve` with
  `{"action":"retry"}` (sends the owner a fresh approval) or `{"action":"cancel"}`. Operators never approve for an owner.
- Dead jobs: `GET /ops/jobs/dead`, fix the cause, `POST /ops/jobs/:id/replay` (publish replays are safe: the ledger dedupes).
- Pause a workspace: `POST /ops/workspaces/:id/pause` with a reason. Every operator action is audited.
- AI cost: `GET /ops/workspaces/:id/usage` (priced, unpriced and measured events shown separately).
