'use strict';

// Authoritative source: dio-select-sync/lib/select-metadata.cjs.
// Refresh after a renderer change (from this repository):
//   node scripts/vendor-select-metadata.js --write ../../../outputs/dio-select-sync/lib/select-metadata.cjs
// Verify before releasing both repositories together:
//   node scripts/vendor-select-metadata.js --check ../../../outputs/dio-select-sync/lib/select-metadata.cjs
// CI can use --check without a source checkout to verify the pinned version/hash.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const repositoryRoot = path.resolve(__dirname, '..');
const vendoredPath = path.join(repositoryRoot, 'lib/select-metadata.cjs');
const manifestPath = path.join(repositoryRoot, 'lib/select-metadata-source.json');
const defaultSourcePath = path.resolve(repositoryRoot, '../../../outputs/dio-select-sync/lib/select-metadata.cjs');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function checkVendor(sourcePath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const bytes = fs.readFileSync(vendoredPath);
  if (sha256(bytes) !== manifest.sha256) throw new Error('Vendored Select renderer does not match its pinned source hash');
  const { RENDERER_VERSION } = require(vendoredPath);
  if (RENDERER_VERSION !== manifest.version) throw new Error('Vendored Select renderer version does not match its manifest');
  if (sourcePath && !bytes.equals(fs.readFileSync(sourcePath))) {
    throw new Error('Vendored Select renderer differs from the authoritative source; refresh it before release');
  }
  return { version: manifest.version, sha256: manifest.sha256, authoritativeSourceChecked: Boolean(sourcePath) };
}

function writeVendor(sourcePath) {
  const bytes = fs.readFileSync(sourcePath);
  const { RENDERER_VERSION } = require(sourcePath);
  if (typeof RENDERER_VERSION !== 'string' || !RENDERER_VERSION) throw new Error('Authoritative renderer must export RENDERER_VERSION');
  fs.writeFileSync(vendoredPath, bytes);
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    sourceRepository: 'dio-select-sync',
    sourcePath: 'lib/select-metadata.cjs',
    version: RENDERER_VERSION,
    sha256: sha256(bytes),
  }, null, 2)}\n`);
  return checkVendor(sourcePath);
}

if (require.main === module) {
  try {
    const [command, sourceArgument, ...unexpected] = process.argv.slice(2);
    if (unexpected.length || !['--check', '--write'].includes(command) || (command === '--write' && !sourceArgument)) {
      throw new Error('Usage: node scripts/vendor-select-metadata.js --check [source-file] | --write <source-file>');
    }
    const sourcePath = sourceArgument ? path.resolve(sourceArgument)
      : fs.existsSync(defaultSourcePath) ? defaultSourcePath : null;
    const result = command === '--write' ? writeVendor(sourcePath) : checkVendor(sourcePath);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { checkVendor, sha256 };
