'use strict';

require('dotenv').config();

const {
  DEFAULT_DB_NAME,
  DEFAULT_URI,
  closeDatabase,
  connectDatabase,
  setupCollections,
} = require('./src/database');

async function main() {
  await connectDatabase();
  await setupCollections();

  console.log(
    `MongoDB initialized for ${DEFAULT_DB_NAME} using ${DEFAULT_URI}.`
  );
}

main()
  .catch((error) => {
    console.error('Setup failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
