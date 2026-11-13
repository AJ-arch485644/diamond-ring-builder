'use strict';
const fs = require('fs');

// Hands values to later workflow steps through $GITHUB_OUTPUT; no-op outside Actions.
function writeWorkflowOutput(values, env = process.env) {
  if (!env.GITHUB_OUTPUT) return;
  fs.appendFileSync(env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
}

module.exports = { writeWorkflowOutput };
