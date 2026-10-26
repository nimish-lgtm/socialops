# Goal coverage

Goal: "A WhatsApp-first operator that runs social accounts end to end for three kinds of users: a normal person who
wants to share memories and stay connected, a creator who wants to grow an audience, and a business that wants customers."

Tests: `tests/goal.test.ts` (23 journeys through the signed webhook, real Postgres, fake platforms; 14 gaps as `it.todo`).
Nothing here is verified against real WhatsApp, Meta or a live model.

## Verdict per part of the goal

| Part of the goal | Covered today | Not covered (it.todo) |
|---|---|---|
| WhatsApp-first | Everything is driven from WhatsApp except one connect link (G-01); 3 owner messages per post: media, consent tap, approve tap (G-02) | Owners silent for 24h+ only get cards when they next write (no templates) |
| End to end | Onboarding → connect → media → caption → consent → approval → publish → readback → report → weekly digest (G-01, C-02) | Scheduling, comments, leads, ads |
| Person: share memories | Personal onboarding about memories and people (P-01); personal profiles get an assisted package, never claimed live (P-02); account type never switched (P-03); children never made public (P-04); a person's Page gets verified publishing (P-05); caption model told the workspace is personal (P-06); no ads or spend (P-07); forget/export/delete (P-08) | Per-post audience choice; Devanagari replies; private sharing of a parent's own child (minors always block) |
| Person: stay connected | Nothing beyond posting | Friends' comments and reply drafts (P-GAP-1) |
| Creator: grow an audience | Verified Instagram publishing (C-01); consistent posting counted in the weekly digest with platform numbers (C-02); missing numbers stated, never guessed (C-03); team uploads, creator approves (C-04); no ads by default (C-05) | Scheduling/best time, follower and reach growth, trends and planning, comment replies, second platform |
| Business: wants customers | Prices, dates, phone numbers highlighted (B-01); banned phrases flagged (B-02); wrong posts stopped (B-03); staff/owner/accountant roles (B-04); consent for customers in photos (B-05); Facebook Page publishing (B-06) | Leads from comments/DMs, ads, enquiry links/catalogue, attribution to sales |
| Three kinds side by side | Full isolation of a person, a creator and a business (X-01); best publishable account chosen and named (X-02) | Picking the target account per post |

## Problems the goal tests found and fixed in this round
1. Onboarding asked a normal person "what do you sell, who are your customers". Now questions follow the workspace kind.
2. Someone with a personal Instagram and a Facebook Page got "post it yourself" for Instagram even though the Page could be
   published automatically. Routing now prefers an account the system can publish and verify on.
3. Post timestamps came from the database clock while the rest of the system used the application clock, so digest
   counts were not testable; posts now use the application clock.

## Honest bottom line
The system serves the "share/post" half of all three goals end to end. "Stay connected" (person), "grow" beyond
consistency and reporting (creator), and "customers" beyond publishing (business) are not built yet; those are the
next modules (comments and replies first, since all three personas need them).
