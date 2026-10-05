'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyProfileReadback } = require('../scripts/install-ai-catalog-profiles');

test('profile installation readback compares review flags and all private metadata', () => {
  const id = 'gid://shopify/Product/100';
  const proposed = { [id]: { sourceHash: 'a'.repeat(64), description: 'Reviewed copy', category: 'Add-on', reviewedInternal: true, review: { revision: 1, notes: ['approved'] } } };
  const reordered = { [id]: { review: { notes: ['approved'], revision: 1 }, reviewedInternal: true, category: 'Add-on', description: 'Reviewed copy', sourceHash: 'a'.repeat(64) } };
  assert.doesNotThrow(() => verifyProfileReadback(reordered, proposed));
  for (const change of [
    actual => { delete actual[id].reviewedInternal; },
    actual => { actual[id].reviewedInternal = false; },
    actual => { actual[id].reviewedInternal = 'true'; },
    actual => { actual[id].review.revision = 2; },
    actual => { delete actual[id].review; },
    actual => { actual[id].description = 'Changed'; },
    actual => { actual['gid://shopify/Product/200'] = actual[id]; },
  ]) {
    const actual = JSON.parse(JSON.stringify(proposed)); change(actual);
    assert.throws(() => verifyProfileReadback(actual, proposed), /PROFILE_INSTALL_READBACK_FAILED/);
  }
});
