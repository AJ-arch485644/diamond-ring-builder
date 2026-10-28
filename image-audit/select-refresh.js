'use strict';
// Retired permanently: Diyona Select now means physically held owned inventory.
// Historical model/ledger data remains for audit, but no invocation of this file
// may restore the supplier curation whitelist or write to any Shopify theme.
function retired() { throw new Error('SELECT_CURATION_RETIRED: Select eligibility comes from owned inventory.'); }
if (require.main === module) {
  console.error('SELECT_CURATION_RETIRED: No data or theme assets were changed.');
  process.exitCode = 1;
}
module.exports = { retired };
