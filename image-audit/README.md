# Nightly Image Audit

Report-only QC for catalog images: a shape CNN (EfficientNet-B0, 99.5% val
accuracy, trained on Nivoda-labeled images) checks that every diamond's photo
matches its certificate shape, and an ETag ledger notices when a vendor swaps
an image behind an unchanged URL.

## Hard safety guarantees

- **Writes to the `image_audit` table only.** Never to `diamonds`, never to the
  `public_diamonds` view, no DDL. The storefront cannot be affected by this job.
- **Report-only.** Flags surface in the workflow run summary and a rolling
  `image-qc` GitHub issue. A human reviews the pictures; confirmed bad images
  are added (manually, as today) to the theme blocklist asset
  `assets/bad-image-skus.json`. Nothing is hidden automatically.
- **Independent of the inventory sync.** Separate workflow, separate schedule,
  no shared state; dependencies are installed `--no-save` so `sync.yml`'s
  `npm install` is untouched.
- **Time-budgeted and capped.** Wraps up gracefully before the runner limit;
  anything unfinished is picked up the next night (the ledger makes every phase
  resumable).

## How it works, nightly

1. **Seed** (first run only): loads the one-time offline full-catalog scan
   (`baseline.jsonl.gz`, ~562k classifications from 2026-08-10) into an empty
   `image_audit` table.
2. **Enumerate**: pages through `diamonds` (read-only) and diffs against the
   ledger → brand-new SKUs and SKUs whose `image_url` changed.
3. **Classify**: downloads and classifies the queue (cap `NEW_CAP`, default
   25k). A cert-vs-photo mismatch at ≥85% confidence becomes a flag.
4. **Sweep**: conditional `HEAD` (`If-None-Match`) on the least-recently
   checked ledger rows (cap `SWEEP_CAP`, default 60k → full catalog roughly
   every two weeks). `304` = untouched; a changed ETag means the vendor
   replaced the image, so it's re-downloaded and re-classified.
5. **Report**: run summary table + flag list, `new-flags.json` artifact, and a
   comment on the rolling `image-qc` issue when there's something to review.

## Reviewing flags

Open the `image-qc` issue, eyeball each linked image against its cert shape.
Side-profile / tilted / on-table shots are legitimate vendor presentation —
only a genuinely different shape (or a non-photo diagnostic render) is a
confirmed bad image. Confirmed SKUs go into the theme's
`assets/bad-image-skus.json` (both themes), which the configurator already
enforces fail-open.

## Someday, deliberately (not now)

Auto-enforcement would mean exposing the flag through `public_diamonds` and
filtering in the theme — with auto-unblock when a vendor fixes an image (the
ETag changes and the reclassification comes back clean). That touches the view
the storefront reads, so it stays a manual, human-approved migration.
