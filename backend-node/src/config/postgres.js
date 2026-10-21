const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { databaseUrl } = require('./env');

const pool = new Pool({ connectionString: databaseUrl });

async function initPostgres() {
  const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'sql', 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('PostgreSQL connected');
}

module.exports = { pool, initPostgres };
