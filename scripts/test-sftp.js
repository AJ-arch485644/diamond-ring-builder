// One-shot SFTP smoke test for the Nivoda migration.
// Run with: npm run test:sftp
//
// Reads the same NIVODA_FTP_* env vars the real sync uses. Connects,
// lists the root directory, then stats the target file to confirm the
// path is correct before letting the GH Action cron near it.

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const SftpClient = require('ssh2-sftp-client');

async function main() {
  const required = ['NIVODA_FTP_HOST', 'NIVODA_FTP_USER', 'NIVODA_FTP_PASS', 'NIVODA_FTP_PATH'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  const sftp = new SftpClient();
  const host = process.env.NIVODA_FTP_HOST;
  const port = parseInt(process.env.NIVODA_FTP_PORT) || 22;
  const remotePath = process.env.NIVODA_FTP_PATH;

  console.log(`Connecting to ${host}:${port} as ${process.env.NIVODA_FTP_USER}...`);

  try {
    await sftp.connect({
      host,
      port,
      username: process.env.NIVODA_FTP_USER,
      password: process.env.NIVODA_FTP_PASS,
      readyTimeout: 30000
    });
    console.log('Connected.\n');

    console.log('Listing /:');
    const rootList = await sftp.list('/');
    rootList.forEach(e => {
      const kind = e.type === 'd' ? 'DIR ' : 'FILE';
      const size = e.type === 'd' ? '' : `  ${(e.size / 1024 / 1024).toFixed(2)} MB`;
      console.log(`  ${kind}  ${e.name}${size}`);
    });

    console.log(`\nChecking target path "${remotePath}"...`);
    const exists = await sftp.exists(remotePath);
    if (!exists) {
      console.error(`FAIL: ${remotePath} not found on server.`);
      console.error('Inspect the root listing above and update NIVODA_FTP_PATH.');
      process.exit(2);
    }
    const stat = await sftp.stat(remotePath);
    console.log(`OK: file found.`);
    console.log(`  size:     ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  modified: ${new Date(stat.modifyTime).toISOString()}`);

    console.log('\nAll checks passed. Safe to run the real sync.');
  } catch (err) {
    console.error('SFTP test failed:', err.message);
    process.exit(1);
  } finally {
    await sftp.end();
  }
}

main();
