# SocialOps

A WhatsApp-first assistant that runs Instagram and Facebook posting for small businesses and creators in India.
The owner sends a photo or video on WhatsApp, approves an exact caption with one tap, and the system publishes it through
official APIs, reads it back to verify it is live, and reports the platform's own numbers. User-facing copy is Hinglish.

Status: everything below runs and is tested against fakes and a real Postgres. Nothing has been run against real
WhatsApp, Meta or a live model yet. See `docs/STATUS.md` for exactly what is built, verified and open.

## Quick start (real chat in the browser) — Windows, macOS or Linux

Requirements: Node 22+ and Git. Postgres and ffmpeg are optional.

```sh
git clone -b claude/eloquent-brown-r231x2 https://github.com/nimish-lgtm/socialops
cd socialops
npm install
```

Create `.env` with at least your Claude key and a daily AI budget (never paste the key anywhere else):

```
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=<your key>
AI_DAILY_BUDGET_INR=50
```

```sh
npm run dev                   # then open http://localhost:8080/
```

`npm run dev` runs `MODE=web`: real Claude, real platform APIs, chat in the browser. It generates the server secrets
(`CREDENTIAL_KEY`, `LINK_SECRET`, `OPERATOR_TOKEN`) into `.env` on first start and refuses to start without the Claude key
and budget. It uses the Postgres at `DATABASE_URL` if one is running; otherwise it starts a built-in Postgres
(stored in `./data/pg`, first start takes about 20 seconds). Without ffmpeg installed, the media quality check is skipped.

Every new browser is a first-time user: its first message creates that user's own workspace (they are the owner)
and starts onboarding. "New user" in the header starts over as another first-time user. Sign-ups are capped by
`SIGNUPS_PER_DAY` (default 50). The browser identity is a signed cookie, so clearing cookies loses access to that workspace.

What needs which credential (the server prints a warning for each one that is missing, and tells the user honestly in chat):

| Feature | Needs |
|---|---|
| Chat, onboarding, captions | `ANTHROPIC_API_KEY`, `AI_DAILY_BUDGET_INR` |
| Instagram link → public info (Business/Creator accounts only) | `META_LOOKUP_IG_USER_ID` + `META_LOOKUP_TOKEN` (your own IG professional account and a token with `instagram_basic`) |
| Facebook Page link → public info | `META_APP_ID`/`META_APP_SECRET` and Meta's "Page Public Metadata Access" approval |
| YouTube channel link → stats and latest videos | `YOUTUBE_API_KEY` (free, YouTube Data API v3) |
| "connect" (log in to your own Page/Instagram) | `META_APP_ID`/`META_APP_SECRET`, redirect `<PUBLIC_BASE_URL>/connect/meta/callback` |
| Publishing | the above, `META_PUBLISH_ENABLED=true`, and a public https `PUBLIC_BASE_URL` (e.g. a cloudflared tunnel) |

Personal or private profiles, X, LinkedIn, TikTok and post/reel links cannot be read: no official API allows it, and nothing is scraped.

```sh
npm test                      # automated tests (fakes, MODE=mock): goal journeys, fault matrix, RLS, ledger, HTTP, lookups, web chat
npm run eval                  # intent + caption eval sets against the configured model
npm run doctor                # checks configuration for MODE (and the WhatsApp token in live)
```

Tests need a Postgres admin URL in `TEST_DATABASE_URL` (default `postgres://socialops_owner:dev@localhost:5432/postgres`);
each test file runs in its own cloned database.

## How it works

```
WhatsApp ─► /webhook (signature, size limit) ─► ingress (dedupe, 24h window, identity, rate limit)
         ─► router (rules first, model only for free text) ─► workflow engine (state machines as data)
         ─► jobs (Postgres queue) ─► tool gateway ─► adapters (WhatsApp, Instagram/Facebook, Claude, storage)
                                     └► ledger (exactly-once external writes) ─► readback ─► "Live ✅"
```

Safety rules the code enforces (each has a test):
- Nothing is published without the owner's tap on an approval whose hash covers the exact media, caption, account,
  route, audience and consent answer. Any change voids it; only one approval per task can be pending.
- Every gate (approval, consent, workspace active, account connected, token valid) is checked again when the publish job runs.
- External writes go through an idempotency ledger. A timeout is reconciled with the platform or escalated to a human, never retried blindly.
- A post is reported live only after the platform reads it back with the approved caption.
- Row-level security on every workspace table; the app role cannot see another workspace or write without one set.
- Outgoing messages use a transactional outbox with dedupe keys and the 24h window; cards held by the window are re-sent when the owner next writes.
- Model calls are gated by a daily INR budget that fails closed; routine commands never call a model.

## Modes

| MODE | Chat channel | Instagram/Facebook/YouTube | Model | Use |
|---|---|---|---|---|
| mock | fake | fake | fake | automated tests only |
| web | browser chat at `/` | real official APIs | Claude | real users in a browser |
| live | WhatsApp Cloud API | real official APIs | Claude | real users on WhatsApp |

`web` and `live` refuse to start with any fake adapter or missing secret; `live` also refuses the dev DB password.

## Layout

`src/` core code · `migrations/` SQL · `tests/` · `evals/` · `web/` chat page · `docs/` plan, status, facts, decisions, runbook.
