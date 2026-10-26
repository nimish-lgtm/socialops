# Decisions

| Decision | Why | Alternatives |
|---|---|---|
| TypeScript on Node 22, run with tsx | one language, types for every port, no build step | Python sidecars later only if needed |
| Postgres 16 from day one, RLS forced on every workspace table | isolation enforced by the database, not by remembering WHERE clauses | SQLite then migrate (the v3.1 pack's plan) |
| Two DB roles: app (RLS) and system (BYPASSRLS, used only by ingress identity, queue, scheduler, erase) | identity lookup and queue claims must cross workspaces; everything else must not | GUC-based bypass |
| Own job queue on Postgres with SKIP LOCKED | one less service; transactional enqueue with the business change | trigger.dev, Temporal, Hatchet |
| Transactional outbox for WhatsApp messages | a message exists only if the change that caused it committed | send inline (lost or duplicate messages) |
| Workflows as data run by one engine, validated at startup | no flow logic scattered in handlers; reachability and approval guards checked | imperative flows (the v3.1 pack's drift problem) |
| Approval hash includes the consent answer and route | consent changes after the card must void it (bug found in v3.1) | hash caption only |
| Ledger with an in-flight window before reconcile | avoids escalating a call that is still running | reconcile immediately |
| Rules-first routing, Claude for free text and captions, budget fails closed | cost and predictability | model for everything |
| Deterministic claim detection on the card | do not trust the model to report its own risky claims | model-reported claims only |
| Dependencies: fastify, pg, zod, @anthropic-ai/sdk, tsx (+ vitest, fast-check, typescript in dev) | each is mainstream and maintained | — |
