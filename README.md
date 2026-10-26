# SocialOps

A WhatsApp-first assistant that runs Instagram and Facebook posting for small businesses and creators in India.
The owner sends a photo or video on WhatsApp, approves an exact caption with one tap, and the system publishes it through
official APIs, reads it back to verify it is live, and reports the platform's own numbers. User-facing copy is Hinglish.

Status: everything below runs and is tested against fakes and a real Postgres. Nothing has been run against real
WhatsApp, Meta or a live model yet. See `docs/STATUS.md` for exactly what is built, verified and open.

## Quick start (no accounts needed) — Windows, macOS or Linux

Requirements: Node 22+ and Git. Postgres and ffmpeg are optional.

```sh
git clone -b claude/eloquent-brown-r231x2 https://github.com/nimish-lgtm/socialops
cd socialops
npm install
npm run dev                   # then open http://localhost:8080/sim
```

`npm run dev` uses the Postgres at `DATABASE_URL` if one is running; otherwise it starts a built-in Postgres
(stored in `./data/pg`, first start takes about 20 seconds). Without ffmpeg installed, the media quality check is skipped.

In the simulator you chat as the owner, an editor, a viewer or a stranger, send real photos/videos, tap buttons,
and watch tasks, approvals, the ledger, posts, jobs and the audit log update. Fault switches let you make the platform
time out, reject, never go live, expire tokens, or make the model return junk.

```sh
npm test                      # 109 tests (+14 listed gaps): goal journeys, fault matrix, RLS, ledger, HTTP, commands, cost, adapters
npm run demo                  # scripted conversation printed to the terminal
npm run eval                  # intent + caption eval sets against the configured model
npm run doctor                # checks configuration for MODE (and the WhatsApp token in hybrid/live)
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

| MODE | WhatsApp | Instagram/Facebook | Model | Use |
|---|---|---|---|---|
| mock | fake | fake | fake | automated tests |
| sim | browser simulator | fake | fake or Claude | manual testing, demos |
| hybrid | real (Meta test number) | fake | Claude | real phone, nothing published; replies prefixed [SIMULATION] |
| live | real | real (behind META_PUBLISH_ENABLED) | Claude | live checks, then pilots |

`live` refuses to start with any fake adapter, missing secret or dev key.

## Layout

`src/` core code · `migrations/` SQL · `tests/` · `evals/` · `sim/` simulator page · `docs/` plan, status, facts, decisions, runbook.
