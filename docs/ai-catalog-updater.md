# Isolated AI Catalog updater

This background worker writes two existing-product metafields: `custom.ai_catalog_description` and `custom.ai_catalog_category`. It has no route, never creates products, and is not imported by the Ring builder. The product creation, search, pricing, stock, customs, shipping, checkout, feed jobs and Vercel configuration are unchanged.

New-product metadata is delayed until a successful background run. The owner accepted this tradeoff. GitHub schedules target 15-minute checks and a nightly complete scan; they are not a delivery-time guarantee. Shopify Catalog ingestion adds a separate delay.

## Data and review

Jewelry descriptions come from a private reviewed profile bundle. Each entry is keyed by the exact Shopify Product GID and binds `description` and `category` to a semantic `sourceHash`. Source or variant changes require a refreshed review. New unknown jewelry is blocked for review, rather than described by inference. The three original pilot descriptions are preserved verbatim.

Loose diamonds use their own exact Shopify product identity and factual title. The same product's structured description can supply missing optional grades; contradictory or unfamiliar nonempty descriptions require review. The prose contains carat, shape and lab-grown/natural origin, with color and clarity only when present. It does not include supplier names, prices, availability claims, certificates, competitor specifications or competitor aliases. A suitable existing diamond/gemstone category is preserved; a missing or neutral category becomes the custom text `Loose diamonds`, not a fabricated Shopify taxonomy ID. A missing SKU does not prevent describing a single-variant product from its own facts. Malformed nonempty SKUs and ambiguous variants still require review.

The default renderer makes no supplier lookup. Description generation and inventory accuracy are separate checks: this worker does not synchronize stock or remove sold products. Verify the existing availability lifecycle separately before activating a Catalog mapping that includes loose diamonds. Diamonds present only in the supplier feed remain outside this worker until they become Shopify products. No visibility or SEO settings are changed.

This repository and its Actions logs are public. Keep product exports, profiles, unpublished product details, tokens, backups, audit records and diffs in private storage. The worker prints aggregate counts only. Do not upload raw run artifacts to GitHub Actions or releases.

## One-time setup

1. Review and apply `db/ai-catalog-state.sql` in the existing Supabase project. It adds isolated worker state and lease objects with service-role-only access. It does not alter diamond inventory or Shopify token tables. The application does not execute migrations automatically.
2. Install the reviewed profile bundle into the private worker store using `scripts/install-ai-catalog-profiles.js`. Supply the file locally; never commit it or paste its contents into an issue. The local rollout package retains the original reviewed sources and backups.
3. Existing Actions secrets are reused by name: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, and `SHOPIFY_STORE` (the full `*.myshopify.com` domain). The worker reads the existing store token from `shopify_tokens`. Verify its Shopify product/metafield read and write scopes through a dry run and canary; a successful inventory feed does not prove those permissions.
4. Leave repository variables `AI_CATALOG_SCHEDULE_ENABLED` and `AI_CATALOG_WRITES_ENABLED` absent or false until verification. Both the script's `--write` flag and the write-enable variable are required. Scheduled jobs are disabled by default. The workflow accepts production credentials only on `main`.

After setting the three credentials in the local process environment, install the private bundle with:

```sh
AI_CATALOG_INSTALL_PROFILES=true node scripts/install-ai-catalog-profiles.js /absolute/private/path/reviewed-jewelry-profiles.json
```

Installation backs up the previous bundle in the private audit and verifies readback under the same worker lease. Do not put credential values into command history.

The migration and profile installation are separate deployment steps. Merging this code does not enable the schedule, perform a backfill, or change Catalog mapping.

## Fixed four-product verification

The separate `AI Catalog approved four-product canary` manual workflow has no inputs and is a one-time authorization for products `9901307396412`, `9979207221564`, `15402163142972`, and `15402165829948`. It refuses all other products, catalog listing, repeat write attempts for a product, and more than four attempted atomic metafield-pair writes. Both ordinary write and schedule variables must remain absent or false. The normal worker's write gate is unchanged.

`--approved-canary` accepts no additional arguments and runs only from that workflow on this repository's `main`, for the fixed Diyona Shopify store and verified Supabase project, before **2026-10-03 00:00 UTC**. Its private deterministic insert-only receipt is claimed under the existing worker lease before any product write. The receipt is consumed even if later work fails; reruns cannot reuse this authorization. It shares the ordinary worker's concurrency group. A failed receipt claim releases the lease before returning. No database migration or purchase-route change is required.

Use the already-reviewed product content, fresh pre-write backups, compare-and-set checks, and readback verification of the ordinary worker. Success requires exactly four written and verified products, a complete run with no blocked/skipped/no-op products, and no global checkpoint advance. A failed or expired canary needs a new reviewed authorization; do not delete its receipt or enable the broad write/schedule gates to retry it. Catalog mapping remains separate and unchanged.

## Verification and rollout

Run `npm ci --ignore-scripts` and `npm run test:ai-catalog`. Tests mock Shopify and Supabase; they never call the product-creation endpoint or place an order.

Start with the manual workflow in read-only mode. It reads live Shopify data and the private reviewed profiles, and plans updates without writing Shopify metadata, ownership, checkpoints or audits. A local equivalent is:

```sh
npm run catalog:dry-run -- --max-products 25000 --max-duration-seconds 7200
```

A dry run must report whether the scan completed. A whole catalog read is deliberately paced and can take over an hour; the manual workflow allows a two-hour runtime budget. Scheduled slices retain a 20-minute budget. Dry runs do not save checkpoints: allow the complete run to finish or use exact product IDs for a narrower read-only diagnostic. A file replay validates transformations, not production credential scopes, ownership records or availability.

After resolving exceptions, enable writes for a manual canary of a few exact product IDs and a small write cap. Take a new dated private catalog snapshot first. Every proposed write also requires a durable private audit entry containing its immediate source and old values. Readback must confirm both saved values and unchanged source. Check representative pilot jewelry, nonpilot jewelry, a loose diamond, and a newly created product. Buyer-flow verification must not accidentally create a live product or order.

Use bounded full-mode slices for the backfill. Independent full and incremental cursors preserve the original time window and remaining IDs on a partial page; every remaining ID is freshly read on resumption. A requested incremental pass can process changes since an unfinished full scan's start, without claiming that historical coverage is complete. If no baseline or pinned full scan exists, an incremental pass requires a full scan first. Exact-ID runs never advance global checkpoints.

When a full scan is pending, a scheduled incremental slice first reserves up to 200 inspections, 40 writes and 40% of its time budget for recent changes, then spends the remaining total budget on the full scan. This prevents a large historical scan from taking precedence over every new product. Finished full scans cannot rewind a newer incremental watermark. A previous version's cursor is migrated only after its original state is backed up in the private audit under the worker lease. Dry runs preview migration in memory without saving anything. Enable scheduling only after valid coverage and representative runtime checks are verified.

Mapping remains a separate decision. Preview the original three styles, other jewelry, loose diamonds and new products before saving the store-wide custom sources. Verify actual Catalog ingestion afterward. Start measurement at the next midnight in America/New_York after confirmed ingestion; retain the original baseline and capture seven complete pre-activation days.

## Failure handling and operations

Writes are atomic pairs and always use Shopify `compareDigest`. An absent field uses explicit `null`. Existing outputs are writable only when ownership records still match their value and digest. Identical existing values can be left as no-ops without adopting ownership. A manual edit, an unknown or changed jewelry profile, or conflicting diamond facts require attention; they must not be overwritten.

Read calls have bounded retries and conservative pacing. An ambiguous mutation is not blindly retried. Post-write verification or persistence failures stop progress; inspect private audit state before retrying. Fresh source and output digests are checked again for each proposed write. Lease/concurrency controls serialize the worker, and only completed progress advances the scan checkpoint.

The separate hourly `AI Catalog health` workflow reads private state without taking a lease, reading the Shopify token or writing anything. It checks blocked records, incremental completion/watermark age, full reconciliation age and progress on each unfinished scan. Defaults flag incremental freshness or stalled progress older than one hour, and full reconciliation older than 48 hours. Missing measurements remain unavailable, never zero; worker health is not proof of Catalog ingestion or new-product latency.

GitHub failure notifications cover failed executions, not a workflow that never starts. The independent readiness monitor must also check the age of successful worker and health runs; two workflows on GitHub do not detect a complete GitHub scheduler outage. Verify notification delivery before activation. Public-repository scheduled workflows may be disabled after 60 days without repository activity. A 15-minute target must not be advertised as a guarantee.

Stop scheduling and writes with the two repository variables if a problem occurs. Restore Catalog mapping to its original standard sources first if necessary. Restore only this worker's two metafields, from the private pre-write audit, when their current values/digests still match the worker's outputs. Preserve later merchant edits. Removal of a field that was originally absent requires a separately reviewed, narrowly scoped rollback; do not replay a whole-product export as a store restore.

References: [Shopify atomic compare-and-set](https://shopify.dev/docs/api/admin-graphql/latest/mutations/metafieldsSet), [GitHub scheduled workflow behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule), [Supabase row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security).
