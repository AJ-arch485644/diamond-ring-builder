'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const script = path.join(__dirname, '..', 'scripts', 'workflow-alert.sh');
const skip = process.platform === 'win32' && 'needs a POSIX shell; CI runs it on Linux';

// Runs the alert script against a stand-in `gh` that reports `openIssue` as the
// open issue with the requested title and records every other call.
function runAlert(args, openIssue = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-alert-test-'));
  const log = path.join(dir, 'calls');
  try {
    fs.writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env bash
if [ "$1 $2" = "issue list" ]; then printf '%s' "$STUB_OPEN_ISSUE"; exit 0; fi
printf '%s\\0' "$@" >> "$STUB_LOG"
printf '\\036' >> "$STUB_LOG"
`, { mode: 0o755 });
    const result = spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, STUB_LOG: log, STUB_OPEN_ISSUE: openIssue,
        GH_TOKEN: 'token', GH_REPO: 'owner/repo', OWNER: 'repo-owner',
        RUN_URL: 'https://example.test/run', RUNBOOK_URL: 'https://example.test/runbook',
      },
    });
    const recorded = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    const calls = recorded.split('\x1e').filter(Boolean).map(call => call.split('\0').slice(0, -1));
    return { status: result.status, calls };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('raise opens one issue that mentions the owner when none is open', { skip }, () => {
  const { status, calls } = runAlert(['raise', 'Feed needs attention', 'failed.']);
  assert.equal(status, 0);
  assert.deepEqual(calls, [['issue', 'create', '--title', 'Feed needs attention', '--body',
    '@repo-owner [this run](https://example.test/run) failed.\n\nStart with the [runbook](https://example.test/runbook). This issue closes itself after the next healthy run.']]);
});

test('raise comments on the open issue instead of opening another', { skip }, () => {
  const { status, calls } = runAlert(['raise', 'Feed needs attention', 'failed.'], '42');
  assert.equal(status, 0);
  assert.deepEqual(calls, [['issue', 'comment', '42', '--body', '[This run](https://example.test/run) failed.']]);
});

test('resolve closes the open issue and does nothing when none is open', { skip }, () => {
  assert.deepEqual(runAlert(['resolve', 'Feed needs attention', 'published fresh data.'], '42').calls,
    [['issue', 'close', '42', '--comment', 'Healthy again: [this run](https://example.test/run) published fresh data.']]);
  assert.deepEqual(runAlert(['resolve', 'Feed needs attention', 'published fresh data.']).calls, []);
});

test('an unknown action fails without touching issues', { skip }, () => {
  const { status, calls } = runAlert(['reopen', 'Feed needs attention', 'failed.'], '42');
  assert.equal(status, 2);
  assert.deepEqual(calls, []);
});
