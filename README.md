# Amazon Review Tracker

Emails Sara every morning when one of our Amazon variation families loses its shared reviews — a child
ASIN splits off its parent, or Amazon stops pooling the family's reviews. No email means nothing changed.

## How it detects reviews falling off

Amazon pools reviews across a variation family: every child listing shows the family's combined ratings
count. When a child is split off (or Amazon un-pools the family), the counts on the listings drop.

| Signal | Source | Why |
| --- | --- | --- |
| Which parent each child sits under, and which children each parent lists | Amazon SP-API Catalog Items (free) | Authoritative family structure. A child losing its parent = split. |
| Ratings count shown on each listing, star rating, the variation's own review count | Keepa (`rating=1`) | Amazon's APIs expose **no** review counts. Keepa is the only source. |

Each day (New York time) the hourly cron advances through:

1. **Listings** — `GET_MERCHANT_LISTINGS_ALL_DATA` report → which ASINs are ours (plus SKUs).
2. **Family check** — Catalog Items for every listing, every parent, and every sibling. A change is
   double-checked before alerting; a child missing from a parent's list is looked up directly and only
   reported once its own record confirms it left (protects against truncated child lists).
3. **Ratings** — Keepa for every variation in a family, priority to families that just changed. Self-throttles
   to the Keepa token bucket (keeps `KEEPA_RESERVE_TOKENS` spare for manual use). A drop of at least
   `ALERT_MIN_DROP` ratings **and** `ALERT_MIN_DROP_PCT`% is an alert.
4. **Email** — after `SEND_HOUR` (8am ET), one digest of everything not yet emailed, grouped by family:
   what happened in plain English, ratings before → after, which variation split off, when Keepa saw it,
   and what to do. Waits up to 3 more hours for Keepa to finish.

The first email ("Review tracker is live") lists what's being watched plus any splits Keepa recorded in
the 60 days before tracking started. Errors email `ADMIN_EMAIL` once per day and retry hourly.

## Setup

1. **Database** — runs inside the profit tracker's Supabase project (no extra cost). In its SQL editor run
   [`supabase/schema.sql`](supabase/schema.sql) (idempotent), then Project Settings → Data API →
   **Exposed schemas** → add `review_tracker`.
2. **Vercel env vars** (see [`.env.local.example`](.env.local.example)):
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — profit tracker's project
   - `LWA_CLIENT_ID`, `LWA_CLIENT_SECRET`, `LWA_REFRESH_TOKEN` — same SP-API app as the profit tracker
   - `KEEPA_API_KEY`
   - `RESEND_API_KEY`, `MAIL_FROM` — the sender's domain must be verified in that Resend account
   - `ALERT_TO` — comma-separated (Sara); optional `ALERT_CC`
   - `ADMIN_EMAIL` — gets error alerts and test emails
   - `CRON_SECRET` — any long random string; Vercel Cron sends it automatically
   - `SITE_PASSWORD` — for the status page; `APP_URL` — the deployed URL (linked from emails)
3. Redeploy so the env vars take effect.

## Checking it works

- **Status page** `/` (browser asks for a password: any username + `SITE_PASSWORD`) — setup checklist,
  today's progress, recent changes, daily runs.
- **Email previews** — `/preview` (next real email), `/preview?sample` (made-up alert), `/preview?welcome`.
- **Test send to ADMIN_EMAIL only** — `curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/test-email`
- **Run a tick now** — `curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron`, or Vercel →
  Settings → Cron Jobs → Run.

## Tuning (env vars, defaults in brackets)

`SEND_HOUR` [8] · `ALERT_MIN_DROP` [10] · `ALERT_MIN_DROP_PCT` [10] · `KEEPA_RESERVE_TOKENS` [100] ·
`SPAPI_MARKETPLACE_ID` [ATVPDKIKX0DER]

## Code map

- `lib/listings.ts` · `lib/catalog.ts` · `lib/reviews.ts` — the three daily stages
- `lib/run.ts` — hourly tick, email step, error alerts
- `lib/digest.ts` — the email (HTML + plain text)
- `lib/spapi.ts` · `lib/keepa.ts` — API clients
- `supabase/schema.sql` — tables: `asins`, `family_snapshots`, `review_snapshots`, `events`, `daily_runs`
