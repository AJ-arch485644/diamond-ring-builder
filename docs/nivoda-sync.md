# Nivoda supplier sync

`Sync Nivoda Diamonds` (`.github/workflows/sync.yml`) keeps `public.diamonds`
in the Supabase `diamond-inventory` project in line with Nivoda's lab-grown
feed. Search, diamond pages, sitemaps and the Google Merchant and OpenAI feeds
all read that table through `public.public_diamonds`.

## What a run does

Every 4 hours (GitHub often starts scheduled runs late), `scripts/sync-nivoda.js`:

1. Downloads the full feed CSV (about 650k diamonds) over SFTP.
2. Reads active supplier reservations from `ops.orders`, so stones tied to open
   orders are written as `reserved`.
3. Upserts every diamond in 500-row batches, stamping `updated_at` with the
   run's sync timestamp.
4. Only after every batch succeeds, marks rows the feed no longer contains as
   `unavailable` (`mark_stale_unavailable`) and deletes them. This is how sold
   stones leave the site. A failed batch, an empty feed or the 100-minute
   upsert deadline stops the run before this step, so a partial run never
   deletes valid stones.
5. Re-reads reservations to catch orders placed during the run.

## What healthy looks like

- A run takes about 10-25 minutes. Progress lines in the log show elapsed
  minutes.
- An upsert that takes longer than 45 minutes counts as slow. The run still
  finishes, but it adds a warning and raises the alert issue.
- A failed, cancelled or slow run opens one issue titled "Sync Nivoda Diamonds
  needs attention" (later problems comment on it) and mentions the repository
  owner. The next healthy run closes it.
- The Google Merchant and OpenAI feeds raise their own alerts if they publish
  supplier data that was last fully refreshed more than 24 hours earlier (see
  `docs/product-feeds.md`).
- GitHub turns off scheduled workflows in public repositories after 60 days
  without repository activity. If runs and alerts stop entirely, check that
  the workflows are still enabled.

## When runs get slow or time out

First check `public.diamonds` for leftover invalid indexes:

```sql
select c.relname as index_name,
       x.indisready as updated_on_every_write,
       pg_size_pretty(pg_relation_size(c.oid)) as size
from pg_index x
join pg_class c on c.oid = x.indexrelid
where x.indrelid = 'public.diamonds'::regclass and not x.indisvalid
order by 1;
```

Names ending in `_ccnew`, `_ccnewN`, `_ccold` or `_ccoldN` are left behind
when a `REINDEX ... CONCURRENTLY` is cancelled part-way. Postgres never uses
them for queries but keeps updating them on every write, so each one slows the
sync. Before dropping one, confirm that the same name without the suffix is
still a valid index. Then drop them one at a time, each as its own statement
outside a transaction:

```sql
DROP INDEX CONCURRENTLY IF EXISTS public.<index_name>;
```

Afterwards, run the workflow manually and confirm that it finishes.

## November 2026 outage

Runs slowed from November 4, and every run from November 7 to 13 hit the
2-hour limit. The same cause produced the October 25-28 timeouts.

- Five `pg_cron` jobs (`reindex-diamonds-shape`, `reindex-diamonds-shape-lab-price`,
  `reindex-diamonds-upgrade`, `reindex-diamonds-price-carat` and
  `reindex-diamonds-lab-price-lean`) ran `REINDEX INDEX CONCURRENTLY` every
  4 hours at minutes 15-19.
- The database's 30-second `statement_timeout` also applies to `pg_cron` jobs.
  Rebuilds that overlapped the sync ran longer and were cancelled, and each one
  left an invalid copy behind. 67 copies built up, adding 3.7 GB of indexes
  that every write had to update.
- The upsert fell from roughly 40,000 rows a minute to about 1,600.

On November 13 the jobs were paused (`active = false`, not deleted) and the 67
leftovers were dropped. The next run finished in about 17 minutes. Do not
re-enable the jobs as they are. If periodic rebuilds are wanted again, run
them while the sync is not writing and without the 30-second limit, and check
for leftovers afterwards.
