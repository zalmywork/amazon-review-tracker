-- Amazon Review Tracker — lives in its own schema inside the profit tracker's
-- Supabase project. Idempotent: safe to re-run.
-- After running: Supabase → Project Settings → Data API → Exposed schemas → add review_tracker.

create schema if not exists review_tracker;

-- Every ASIN we watch: our own listings, plus every parent and sibling in
-- their variation families (siblings count toward the shared review pool).
create table if not exists review_tracker.asins (
  asin                  text primary key,
  skus                  text[] not null default '{}',
  listed                boolean not null default false,
  listing_status        text,
  title                 text,
  brand                 text,
  image_url             text,
  variation_label       text,
  item_classification   text,
  is_parent             boolean not null default false,
  parent_asin           text,
  child_asins           text[] not null default '{}',
  variation_theme       text,
  ever_in_family        boolean not null default false,
  catalog_found         boolean,
  catalog_checked_on    date,
  rating_count          integer,
  rating                numeric(2,1),
  own_review_count      integer,
  keepa_parent_asin     text,
  keepa_rating_at       timestamptz,
  keepa_checked_on      date,
  keepa_priority        boolean not null default false,
  first_seen_at         timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  tracked               boolean generated always as (listed or ever_in_family or is_parent) stored
);
create index if not exists asins_parent_idx on review_tracker.asins (parent_asin);
create index if not exists asins_tracked_idx on review_tracker.asins (tracked, catalog_checked_on);

-- Daily history of the family structure Amazon's catalog reported.
create table if not exists review_tracker.family_snapshots (
  captured_on   date not null,
  asin          text not null,
  parent_asin   text,
  child_asins   text[],
  primary key (captured_on, asin)
);

-- Daily history of the ratings each variation's listing showed (from Keepa).
create table if not exists review_tracker.review_snapshots (
  captured_on       date not null,
  asin              text not null,
  rating_count      integer,
  rating            numeric(2,1),
  own_review_count  integer,
  keepa_parent_asin text,
  keepa_rating_at   timestamptz,
  primary key (captured_on, asin)
);

-- Things worth telling Sara about. One row per change; emailed_at marks it sent.
create table if not exists review_tracker.events (
  id           bigint generated always as identity primary key,
  detected_at  timestamptz not null default now(),
  detected_on  date not null,
  type         text not null,
  asin         text not null,
  family_asin  text,
  details      jsonb not null default '{}',
  emailed_at   timestamptz,
  constraint events_once_per_day unique nulls not distinct (detected_on, type, asin, family_asin)
);
create index if not exists events_unsent_idx on review_tracker.events (emailed_at) where emailed_at is null;

-- One row per day (America/New_York) tracking how far the daily job got.
create table if not exists review_tracker.daily_runs (
  run_on              date primary key,
  listings_report_id  text,
  listings_attempts   integer not null default 0,
  listings_done_at    timestamptz,
  catalog_done_at     timestamptz,
  keepa_done_at       timestamptz,
  email_sent_at       timestamptz,
  email_result        text,
  stats               jsonb not null default '{}',
  last_error          text,
  last_error_at       timestamptz,
  admin_alerted_at    timestamptz,
  updated_at          timestamptz not null default now()
);

-- Server-only access: the app uses the service role. RLS on with no policies
-- keeps the anon key out even though the schema is exposed to the Data API.
alter table review_tracker.asins            enable row level security;
alter table review_tracker.family_snapshots enable row level security;
alter table review_tracker.review_snapshots enable row level security;
alter table review_tracker.events           enable row level security;
alter table review_tracker.daily_runs       enable row level security;

grant usage on schema review_tracker to service_role;
grant all on all tables in schema review_tracker to service_role;
grant all on all sequences in schema review_tracker to service_role;
alter default privileges in schema review_tracker grant all on tables to service_role;
alter default privileges in schema review_tracker grant all on sequences to service_role;
