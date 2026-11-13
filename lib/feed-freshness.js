'use strict';
const { writeWorkflowOutput } = require('./workflow-output');

// A complete Nivoda sync stamps every listed supplier diamond with that run's
// timestamp and deletes diamonds missing from the supplier feed, so the oldest
// supplier updated_at in an export is when the catalog was last fully
// refreshed. Failed or partial syncs never move it forward. Syncs are scheduled
// every 4 hours, but GitHub can start them many hours late, hence 24 hours.
const STALE_SUPPLIER_HOURS = 24;

function supplierRefreshedAt(rows) {
  let oldest = Infinity;
  for (const row of rows) {
    if (row.inventory_source !== 'supplier') continue;
    const time = Date.parse(row.updated_at);
    if (Number.isFinite(time) && time < oldest) oldest = time;
  }
  return Number.isFinite(oldest) ? oldest : null;
}

// Logs how old the supplier data in an export is and hands `stale`,
// `supplier_age_hours` and an alert sentence (`freshness_note`) to the
// workflow. Publishing still goes ahead: skipping it would leave an even older
// feed live.
function reportSupplierFreshness(rows, { now = Date.now(), staleHours = STALE_SUPPLIER_HOURS, writeOutput = writeWorkflowOutput } = {}) {
  const refreshedAt = supplierRefreshedAt(rows);
  if (refreshedAt === null) {
    const note = 'found no supplier diamonds with a refresh time, so their freshness is unknown.';
    console.log(`::warning title=Supplier freshness unknown::This export ${note}`);
    writeOutput({ stale: 'true', supplier_age_hours: 'unknown', freshness_note: note });
    return { stale: true, ageHours: null, note };
  }
  const ageHours = (now - refreshedAt) / 3600000;
  const age = ageHours.toFixed(1);
  const stale = ageHours > staleHours;
  const note = stale
    ? `published supplier diamonds last fully refreshed ${age} hours earlier, so sold stones and old prices may be listed. Check the Sync Nivoda Diamonds workflow.`
    : `published supplier diamonds refreshed ${age} hours earlier.`;
  console.log(`Supplier data last fully refreshed at ${new Date(refreshedAt).toISOString()} (${age} hours ago)`);
  if (stale) console.log(`::warning title=Stale supplier data::Supplier diamonds were last fully refreshed ${age} hours ago, over the ${staleHours}-hour limit. Check the Sync Nivoda Diamonds workflow.`);
  writeOutput({ stale: String(stale), supplier_age_hours: age, freshness_note: note });
  return { stale, ageHours, note };
}

module.exports = { STALE_SUPPLIER_HOURS, supplierRefreshedAt, reportSupplierFreshness };
