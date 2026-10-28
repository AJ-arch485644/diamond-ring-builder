# Owned inventory backend

The public catalog is `public.public_diamonds`. It retains the supplier fields and
adds `inventory_source`, `is_diyona_select`, `shopify_product_id`,
`shopify_variant_id`, `product_handle`, `catalog_revision`, and
`catalog_updated_at`. IDs in this public projection are numeric strings. Owned
rows enter it only after the protected inventory lifecycle permits sale.

`create-product` resolves protected owned identities first, including drafts,
withdrawn stones and test fixtures. An owned identity can never fall through to
supplier product creation. Sellable owned stones reuse their exact persisted
Shopify mapping after a native read verifies identity, publication, tracked
quantity and approved base price. Shopify remains authoritative for cart and
checkout stock consumption and market pricing. The existing customs-code update
for Loose versus Ring intent remains; it does not change quantity or create a
product. Dispatch is already synchronized at one business day.

Search ranks matching owned stones before supplier rows in the database, before
pagination. SEO and feeds use the same safe catalog and link owned stones to their
native product handle, avoiding ambiguous slug parsing for stock codes with
hyphens. The old supplier Select curation writer is retired; image QC remains.

`GET`/`POST /api/search` returns at most `per_page` rows and uses one extra matching
row to compute `Diamonds.has_more`. `Diamonds.total` is `null` by default; callers
must use `has_more` for navigation. Set `count=exact` explicitly when a total is
required; broad exact counts can be expensive. Filtering and owned-first ordering
remain global before pagination. No approximate count is substituted.

## Release order

1. Deploy the database projection, lifecycle fields, Ops per-line order
   migration and supplier reservation guard before this backend. The supplier
   importer requires `diamond_lines`; cart checks require the protected
   `ops.supplier_order_reservations` view.
2. Provision the separate owned OAuth client with inventory and publication
   permissions. The existing Ring Builder token lacks those scopes. Verify the
   owned client can read mapped stock and Online Store publication `135477526844`.
3. Stage this backend, verify the supplier path still resolves without publishing
   a new product, and verify draft owned identities return unavailable.
4. Promote an approved owned canary through the sync service. Verify its native
   quote, search, PDP, loose cart, ring cart and inventory/order event handling.
5. Roll out approved held inventory, then enable theme discovery/recommendations.
   Keep database lifecycle and Shopify publication rollback available.

## Verification

`node --test tests/*.test.js` covers owned cart identity, credentials, search and
supplier import safety. Tests use isolated mocks; no tests create Shopify products or mutate the
live database. Commerce tests run in a secret-free GitHub workflow.

## Remaining operational limits

The supplier import still refreshes rows in place. Latest observed run on
October 28, 2026 parsed 662,188 rows but timed out after 30 minutes around 175,000 rows,
including a database statement timeout. The bounded repair allows 120 minutes,
prevents overlapping workflow writers, retries failed batches, and aborts before
stale deletion on unrecovered errors or empty input. Reservations include every
supplier line in mixed orders; owned lines never change supplier flags. The
public catalog independently excludes active supplier order allocations, so an
in-place overwrite or newly inserted feed row cannot relist an ordered stone.
Cart checks the protected allocation view before supplier preparation and before
returning a variant; failed reservation reads fail closed. This does not provide atomic
feed-generation promotion. That requires a separate staging/generation design.

Existing supplier first-creation concurrency is not a distributed transaction;
the owned path never enters it. Existing supplier compare-at pricing and customs
classification behavior are preserved. Refund/cancellation restock authority is
handled by the inventory/order integration, never inferred here.

Dependency audit on the unchanged lockfile reported existing `csv-parse` moderate
and `ws` high advisories. No unreviewed major package upgrade was included.
