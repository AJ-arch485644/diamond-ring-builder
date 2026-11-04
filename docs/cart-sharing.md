# Diyona cart-sharing foundation

Status: implemented for review, disabled by default, not connected to the live theme.
No button, page route, automatic import, theme include, product-creation change,
supplier-feed change, checkout change, or production database migration is included.

## Why a saved snapshot

Shopify cart permalinks support properties on only the first product, which is
insufficient for a setting, diamond and engraving-fee group. This implementation
stores a versioned cart recipe and exposes an opaque, expiring bearer token.
It never shares a Shopify cart token, customer session, checkout URL or cookies.

The source audit used live theme `187284947260` on 6 October 2026 and backend main
`c75dcd5795085bb074a2340a1e15aa1e0a6e7c61`. Relevant live files include
`optimistic-cart.js`, `diyona-native-cart.js`, `main-cart.liquid`, `cart-item.liquid`,
`cart.ajax.liquid`, standard/TT ring builders, product templates, and attribution.

## Implemented flow

1. **Capture:** acquire the caller's cart writer barrier; read a settled cart twice;
   validate composition; save the snapshot; re-read and confirm the source is still
   unchanged before returning its token. Pending producers are awaited outside the
   barrier, with a bounded deadline. The sentinel `51975403077948`, pending flags,
   real-plus-placeholder transition, partial fees, mismatched paired sizes and
   conflicting operation identities cannot become a snapshot.
2. **Preview:** read the saved recipe. Merely opening a link never adds anything,
   creates a product, reserves a stone or starts checkout.
3. **Prepare:** read current supplier availability and exact Shopify variants,
   validate product roles, total quantities, tracked inventory and recipient market
   publication/prices. Rebuild diamond descriptions/certificates and paired setting
   titles from current supplier/catalog records. Return all lines or an error. Preparation lasts at most two minutes and
   never extends the share's lifetime. Prices and availability are not locked.
4. **Restore:** the SDK requires an explicitly reviewed preparation handle, the
   same recipient cart/context, and an empty recipient bag. It saves a durable
   attempt receipt before exactly one multi-item Ajax add, then reads the cart back.
   Each ring receives a fresh operation identity; each import and line is stamped.
   Lost responses are verified rather than replayed. Partial/uncertain results never
   trigger an automatic second add, clear, rollback or removal.
5. **Recover:** `recover(token)` checks a prior attempt read-only, including after
   reload or preparation expiry. It never imports a missing selection again.

This is a cart recipe, not a reservation or an atomic Shopify transaction. A stone
can sell between preparation and add. Shopify Ajax/checkout remain final authority.

## Preserved and excluded data

The shared contract keeps each line's real variant, quantity and SKU; paired setting
and diamond identities; exact ring-size text, including empty versus absent keys;
the missing-size marker; chain options; and validated engraving with its exact paid
fee. Shopify may omit empty properties on readback; this still means unsized, never
a default size. A shared unsized ring remains subject to the existing checkout gate.

The diamond's hidden `_engraving` can be stale after a normal cart edit. The validated
setting/fee pair is authoritative; canonical diamond metadata is rebuilt from it.
Settled loose-diamond markers are retained so existing checkout validation applies.
Nonempty sizes must match the current US 3–10 range in quarter-size increments;
numeric and Unicode fraction formats are preserved exactly. Other nonempty sizes
fail explicitly. Saved preview labels are untrusted sender content; only preparation
revalidates descriptions against current native identities. It does not validate
physical manufacturing compatibility beyond the existing cart's product identities.

Source operation IDs, pending/display estimates, image URLs and promised dates are
not transferred. Native product images/prices and fresh cart delivery calculations
must be used. The exact known attribution and TT diagnostic attribute names are
excluded; the recipient's existing tracking attributes remain untouched. Unknown
attributes fail explicitly. Private Shopify attributes inaccessible through Ajax
cannot be cloned by this feature.

Version 1 deliberately refuses notes, mail-in/IGI/TikTok order-number configurations,
upload links, unknown properties, subscriptions, native bundles/components, malformed
or ambiguous groups, and unsafe text for the current theme renderer. It does not
transfer discount codes or promise a sender's total. Some text containing markup
delimiters, including ampersands or double quotes, is currently refused because
the live generic property renderer is not consistently escaped. Do not weaken this
validation without first safely changing and reviewing that renderer.

Limits: one diamond selection (a ring group or a loose diamond), 30 lines total,
quantity 1–10 for ordinary products, quantity one per unique stone
and each ring component, 64 KiB request/snapshot bound. Unsupported input is an
explicit refusal, never silent partial sharing. Cart attributes can be allowlisted
for storage, but v1 restore refuses nonempty shared attributes because writing them
requires a separate, non-atomic endpoint; leave that allowlist empty for this version.

## Files and API

| File | Responsibility |
| --- | --- |
| `lib/cart-share-contract.js` | Same canonical validator in Node and browser (UMD) |
| `lib/cart-share-service.js` | Snapshot service, read-only catalog checks, HTTP handler |
| `lib/cart-share-store.js` | Private snapshot/rate RPC and supplier read adapters |
| `api/cart-shares.js` | Dormant Vercel route |
| `db/cart-shares.sql` | Additive private tables, atomic limiter, bounded cleanup |
| `theme/assets/diyona-cart-share.js` | Inert capture/preview/prepare/restore/recover SDK |
| `tests/cart-share-*.test.js` | Unit, adversarial, integration and PostgreSQL tests |

`POST /api/cart-shares` with JSON `{action:"create",snapshot}` returns
`{token,expiresAt,snapshotHash,snapshot}` with HTTP 201.

`GET /api/cart-shares?token=...` returns `{snapshot,expiresAt,snapshotHash}`.
Expired, revoked and missing tokens share the same 404 response.

`POST /api/cart-shares` with JSON `{action:"prepare",token,country:"US",currency:"USD"}`
returns `{preparation}` with validated lines and per-line `unitPrice`,
`priceLocked:false` and `availabilityConfirmed:false`.

All responses are private/no-store at browser and CDN layers. JSON bodies and
methods are bounded. Exact allowed Origin is required. Origin checking is not
authentication: anonymous sharing uses unguessable tokens plus distributed rate
limits. On Vercel the limiter uses its platform client-IP header, otherwise the
socket address; client identifiers are stored only as keyed hashes. Rate checks
write only the new private rate table. Preview/prepare never mutate commerce data.

## Backend configuration and migration

Keep `CART_SHARE_ENABLED` unset or `false` until all release checks below pass.
Disabled requests return 404 before creating a database client or reading credentials.

| Variable | Value/meaning |
| --- | --- |
| `CART_SHARE_ENABLED` | Exact `true` enables the route |
| `CART_SHARE_ALLOWED_ORIGINS` | JSON array of exact HTTPS storefront origins |
| `CART_SHARE_RATE_SECRET` | Independent random secret, at least 32 characters |
| `CART_SHARE_TTL_SECONDS` | Default 604800 (7 days), allowed 1 hour–30 days |
| `CART_SHARE_ALLOWED_ATTRIBUTES` | JSON array, default `[]`; keep empty for v1 restore |
| `CART_SHARE_ENGRAVING_VARIANT_ID` | Exact verified engraving fee variant; audited `52843400102204` |
| `SHOPIFY_STORE` | Existing store host, validated `.myshopify.com` host |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Existing server-only project credentials |

The Shopify token comes from the existing private `shopify_tokens` table.
No service key or Admin API token belongs in a theme asset or share URL.

Apply `db/cart-shares.sql` first to an isolated test database. It has no foreign keys
to transient supplier rows and does not alter any existing table. Both new tables
have RLS enabled and no public/anon/authenticated access. The service role can
insert/read snapshots but cannot directly update/delete them. Tokens contain 32
random bytes; only their SHA-256 hashes are persisted in the table. Stored recipes
are immutable and integrity-checked. An authorized database operator can set
`revoked_at` when a link must be revoked.

Before enabling, arrange bounded calls to `cart_share_cleanup(1000)` through the
deployment's maintenance process; repeat bounded batches as needed. It removes
expired snapshots/rate rows older than a one-day grace period. This change does not
install a production schedule. Suppress token/payload logging in proxies, telemetry
and error reporting; the HTTP GET query necessarily contains the bearer token.

## Frontend integration contract — required before activation

The source is intentionally not included by any live Liquid template. To integrate
later, serve both UMD files, load the contract first, then create the SDK with
`enabled:true`, an explicit HTTPS API URL, the locale-aware Shopify root, secure
Web Crypto and a working durable localStorage journal.

The mandatory coordinator supplies:

```js
{
  state() { return { ready, busy, revision, context }; },
  async exclusive(work) { /* Serialize every cart writer, then await work(). */ }
}
```

`ready` means all cart-writing paths and unresolved/unsaved intents are accounted
for. `busy` reflects external producers/edits. `revision` is an integer changed by
external mutations; `context` pins route/PJAX lifetime, country and currency. During
the SDK-owned operation its own lock does not make `busy` true or bump the external
revision. After release, publish the resulting mutation and refresh the existing
cart renderer and checkout validation. Coordinate same-origin tabs as well.

The present theme exports only a size-saving getter and partial mutation events.
Native fallback adds, TT paths, attribution writes and private unresolved attempts
are not all covered. An event-only observer or two matching Ajax reads is not a
complete barrier. Never provide a permanently-ready stub in production. Integrating
this coordinator requires a separate reviewed theme change; it is not done here.

Do not call `restore` on page load. Render a recipient review and require their
explicit import action. Use textContent/escaped Liquid for all displayed data.
Place the future share token in a URL fragment to avoid ordinary referrer/query
exposure and keep that page out of indexing; no URL route is created by this change.
Resolve the fresh native cart after import, refresh delivery promises, and retain
size/engraving/pending/wallet guards. The SDK always returns `checkoutReady:false`.

## Existing-system caveats and release checks

The legacy `create-product` endpoint has fuzzy first-result reuse, no durable
concurrent creation lock, and updates fulfillment/HS metadata even for a reused
variant. Shared previews/restores never call it. A missing or deleted variant is
blocked rather than recreated or replaced by a similar diamond. The current native
HS field is checked against the existing Ring/Loose intent contract; a mismatch is
blocked without a catalog write. That global field can still change afterward in
another legacy purchase flow, so this check is not a checkout-wide guarantee.

The supplier feed deletes unavailable diamonds, while reservation logic runs on
orders. Shares neither pin feed records nor reserve inventory. A readable saved
recipe can therefore have an unavailable stone at restoration time.
Supplier availability here means the current Supabase feed row, not a real-time
Nivoda reservation. The four-hour scheduled import can be delayed. The existing
import also has unsafe cleanup paths after incomplete imports; this feature does
not alter or mask those failures. Missing/duplicate rows and upstream failures block
restoration rather than replacing a selected stone.

The operations service `diyona-ops/lib/shopify/parse-order.ts` currently reduces an
order to one diamond/setting/size/engraving tuple. Therefore v1 rejects multiple
diamond selections even when the cart groups are individually valid. The parser's
setting-SKU fallback can also select a builder diamond or engraving fee because
it treats any builder line without `Diamond SKU` as the setting. Existing order
processing is not changed here; validate/fix this downstream identity mapping
before activation rather than claiming that native cart preservation proves correct
fulfillment. Raw Shopify line items are retained by that service for investigation.

Run `npm run test:cart-share` and the existing quote/catalog suites. The PostgreSQL
test runs only with `CART_SHARE_TEST_DATABASE_URL` pointing to localhost database
`cart_share_test`; CI supplies a disposable PostgreSQL 16 service and tests RLS,
grants, concurrent rate consumption and cleanup without merchant credentials.

Before any activation, verify the actual target Supabase migration and credentials,
Shopify token scopes and current catalog/fee identities, Vercel no-store/CORS/IP
behavior, and isolated real-Shopify Ajax round trips. Exercise missing sizes,
engraving, ordinary jewelry, loose/ring stones, publication delays, sold-out stock,
lost/partial responses, reload, two tabs, recipient market changes and supported
TT/mobile browsers. Keep the existing native checkout and wallet guards in control.

Rollback: disable `CART_SHARE_ENABLED` and any future frontend activation. Existing
commerce paths do not depend on this feature. Keep private tables for investigation
and expiry cleanup rather than dropping saved state during an incident.

References: [Shopify cart permalinks](https://shopify.dev/docs/apps/build/checkout/create-cart-permalinks),
[Ajax Cart API](https://shopify.dev/docs/api/ajax/reference/cart),
[Shopify contextual publication](https://shopify.dev/docs/api/admin-graphql/2026-07/input-objects/ContextualPublicationContext),
[Vercel request headers](https://vercel.com/docs/headers/request-headers).
