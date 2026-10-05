'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const run = flags => spawnSync(process.execPath, [path.join(__dirname, '../scripts/check-ai-catalog-health.js')], {
  encoding: 'utf8', env: { PATH: process.env.PATH, ...flags },
});

test('disabled health check needs no private credentials and is explicitly disabled', () => {
  const result = run({});
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).status, 'disabled');
});

test('scheduled dry-run misconfiguration fails before credentials or network are needed', () => {
  const result = run({ AI_CATALOG_SCHEDULE_ENABLED: 'true', AI_CATALOG_WRITES_ENABLED: 'false' });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).issues, ['SCHEDULE_ENABLED_WITH_WRITES_DISABLED']);
});

test('enabled check with missing credentials fails without printing sensitive errors', () => {
  const result = run({ AI_CATALOG_SCHEDULE_ENABLED: 'true', AI_CATALOG_WRITES_ENABLED: 'true' });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'AI_CATALOG_HEALTH_CHECK_FAILED: health could not be verified; inspect private runtime access.');
});
