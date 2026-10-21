// Seeds MongoDB with sample products and creates demo users in PostgreSQL.
// Usage: npm run seed
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const connectMongo = require('./config/mongo');
const { pool, initPostgres } = require('./config/postgres');
const Product = require('./models/Product');
const products = require('./data/products.json');

const USERS = [
  { name: 'Admin', email: 'admin@shop.local', password: 'admin123', role: 'admin' },
  { name: 'Demo Shopper', email: 'demo@shop.local', password: 'demo123', role: 'customer' },
];

(async () => {
  await Promise.all([connectMongo(), initPostgres()]);

  await Product.deleteMany({});
  await Product.insertMany(products);
  await Product.syncIndexes();
  console.log(`Inserted ${products.length} products`);

  for (const u of USERS) {
    await pool.query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING`,
      [u.name, u.email, await bcrypt.hash(u.password, 10), u.role]
    );
    console.log(`${u.role} user: ${u.email} / ${u.password}`);
  }

  await mongoose.disconnect();
  await pool.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
