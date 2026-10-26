# External facts used by the code

Every platform fact the code depends on, with its source state. UNVERIFIED items must be confirmed on the vendor's own
documentation before the matching capability is switched on.

| Fact | Used in | Source state |
|---|---|---|
| Webhook POSTs carry `X-Hub-Signature-256: sha256=<hmac of raw body with app secret>` | security/crypto.ts | UNVERIFIED here (secondary sources in v3.1 pack) |
| GET handshake with hub.mode / hub.verify_token / hub.challenge | http/server.ts | UNVERIFIED |
| Free-form messages only within 24h of the user's last message; templates otherwise | core/messenger.ts | UNVERIFIED (Meta pricing page read in v3.1 pack says service messages in window are not charged) |
| Reply buttons: max 3, title ≤ 20 chars, id ≤ 256, body ≤ 1024 | adapters/cloud-whatsapp.ts | UNVERIFIED |
| Media download: GET /{media-id} → url, then GET url with bearer | adapters/cloud-whatsapp.ts | UNVERIFIED |
| Instagram publish: POST /{ig-user-id}/media → container, poll status_code until FINISHED, POST /media_publish | adapters/meta-social.ts | UNVERIFIED |
| Instagram API cannot publish to personal accounts; Facebook API cannot publish to personal profiles | accounts/matrix.ts | UNVERIFIED (secondary sources) |
| Facebook Page photo/video publish via /{page-id}/photos and /videos | adapters/meta-social.ts | UNVERIFIED |
| Token error code 190 = expired/invalid token | adapters/meta-social.ts | UNVERIFIED |
| OAuth dialog, code exchange, long-lived token, me/accounts with instagram_business_account | accounts/meta-oauth.ts | UNVERIFIED |
| Claude model ids claude-haiku-5-5, claude-sonnet-5-5 | config | From the session environment's model list and the v3.1 pack; account access unverified |
| Model prices and USD/INR rate in config/prices.json | core/cost.ts | Copied from the v3.1 pack (pricing page read 2026-10-25); re-verify |
