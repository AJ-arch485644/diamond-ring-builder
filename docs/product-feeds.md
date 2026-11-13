# Product feeds

Two workflows publish the diamond catalog (`public.public_diamonds`) to
shopping surfaces. Both read it with the anon key and publish whatever it
holds, so they are only as fresh as the Nivoda sync (`docs/nivoda-sync.md`).

| Workflow | Schedule (UTC) | Publishes |
|---|---|---|
| Google Merchant Feed (`merchant-feed.yml`) | Every 6 hours | `diyona-diamonds.tsv` to Google Merchant Center over SFTP |
| OpenAI Product Feed (`openai-feed.yml`) | Every 6 hours, 3 hours after Google | `diyona-diamonds-openai.tsv.gz` on the rolling `feeds` GitHub release |

GitHub often starts scheduled runs late or skips them, so in practice each
feed refreshes two to four times a day.

## Alerts

Each feed keeps one open issue, "Google Merchant Feed needs attention" or
"OpenAI Product Feed needs attention", which mentions the repository owner.
Later problems comment on it, and the next healthy run closes it.

- **Failed or cancelled run:** the previously published feed stays live. The
  run log shows which step failed (catalog export, file write, SFTP upload or
  release upload).
- **Stale supplier data:** the run published, but the supplier diamonds were
  last fully refreshed more than 24 hours earlier. The feed job itself is fine;
  the Nivoda sync is not completing. Fix the sync first, then rerun the feed
  or wait for its next run.

## How freshness is measured

A complete Nivoda sync stamps every listed supplier diamond with that run's
timestamp and deletes diamonds missing from the supplier feed. The oldest
supplier `updated_at` in an export is therefore the time of the last complete
sync; failed or partial syncs never move it forward. Every run logs it as
"Supplier data last fully refreshed at ...".

During the November 2026 sync outage it stayed at November 7, 05:50 UTC for
six days. Both feeds kept publishing on schedule, listing sold diamonds as in
stock (about 25,000 by November 13) and stale prices for about 40% of
listings.
