const app = require('./app');
const { port, databaseUrl } = require('./config/env');
const connectMongo = require('./config/mongo');
const { initPostgres } = require('./config/postgres');

// Turns common connection failures into an actionable message
function explain(err) {
  const where = databaseUrl.replace(/\/\/([^:]+):[^@]*@/, '//$1:****@');
  if (err.code === '28P01' || err.code === '28000') return `PostgreSQL rejected the username/password in DATABASE_URL (${where}). Update DATABASE_URL in backend/.env.`;
  if (err.code === '3D000') return `The database in DATABASE_URL (${where}) does not exist. Create it, e.g. CREATE DATABASE shop;`;
  if (err.code === 'ECONNREFUSED') return `Could not connect to ${err.address}:${err.port}. Is the database running?`;
  if (err.name === 'MongooseServerSelectionError') return 'Could not connect to MongoDB. Is it running, and is MONGO_URI correct?';
  return null;
}

(async () => {
  await Promise.all([connectMongo(), initPostgres()]);
  app.listen(port, () => console.log(`API running on http://localhost:${port}`));
})().catch((err) => {
  console.error('\nFailed to start:', explain(err) || err);
  process.exit(1);
});
