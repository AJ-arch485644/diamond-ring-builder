'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { supplierRefreshedAt, reportSupplierFreshness } = require('../lib/feed-freshness');
const openai = require('../scripts/generate-openai-feed');

const now = Date.parse('2026-11-13T20:00:00Z');
const latestSync = { inventory_source: 'supplier', updated_at: '2026-11-13T18:38:17.149+00:00' };
const leftFromOutage = { inventory_source: 'supplier', updated_at: '2026-11-07T05:50:17.114+00:00' };
const owned = { inventory_source: 'owned', updated_at: '2026-01-01T00:00:00+00:00' };
const missingTime = { inventory_source: 'supplier', updated_at: null };

test('the oldest supplier refresh marks the last complete sync and owned rows are ignored', () => {
  assert.equal(supplierRefreshedAt([latestSync, leftFromOutage, owned, missingTime]), Date.parse('2026-11-07T05:50:17.114Z'));
  assert.equal(supplierRefreshedAt([owned, missingTime]), null);
});

test('supplier data past the limit is reported stale and recent data is not', () => {
  const outputs = [];
  const writeOutput = values => outputs.push(values);
  assert.equal(reportSupplierFreshness([latestSync, leftFromOutage, owned], { now, writeOutput }).stale, true);
  assert.equal(reportSupplierFreshness([latestSync, owned], { now, writeOutput }).stale, false);
  assert.deepEqual(outputs.map(({ stale, supplier_age_hours }) => [stale, supplier_age_hours]), [['true', '158.2'], ['false', '1.4']]);
  assert.match(outputs[0].freshness_note, /^published supplier diamonds last fully refreshed 158\.2 hours earlier, so sold stones and old prices may be listed\./);
  assert.equal(outputs[1].freshness_note, 'published supplier diamonds refreshed 1.4 hours earlier.');
});

test('an export without supplier refresh times is treated as stale', () => {
  const outputs = [];
  assert.equal(reportSupplierFreshness([owned, missingTime], { now, writeOutput: values => outputs.push(values) }).stale, true);
  assert.deepEqual(outputs.map(({ stale, supplier_age_hours }) => [stale, supplier_age_hours]), [['true', 'unknown']]);
});

test('the OpenAI export requests the fields the freshness check needs', () => {
  const columns = openai.EXPORT_COLUMNS.split(',');
  assert.ok(columns.includes('updated_at'));
  assert.ok(columns.includes('inventory_source'));
});
