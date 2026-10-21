const { pool } = require('../config/postgres');
const { isProduction, otpTtlMinutes } = require('../config/env');
const Product = require('../models/Product');
const mailer = require('../services/mailer');
const { createPaymentOtp, verifyPaymentOtp } = require('../services/otp');
const { formatPrice } = require('../utils/format');
const { loadCart, summarize } = require('./cartController');

const PAYMENT_METHODS = ['cod', 'upi', 'card'];
const ONLINE_METHODS = ['upi', 'card']; // money moves before delivery, so these need an OTP

const formatAddress = (a) => `${a.name}, ${a.line1}, ${a.city}, ${a.state} - ${a.pincode}. Phone: ${a.phone}`;
const maskEmail = (email) => email.replace(/^(.)(.*)(.@.*)$/, (_, a, mid, b) => a + '*'.repeat(Math.max(mid.length, 1)) + b);

// POST /api/orders/otp - emails a one-time code that confirms an online payment
exports.requestOtp = async (req, res) => {
  const { rows } = await pool.query('SELECT email, name FROM users WHERE id = $1', [req.user.id]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });

  const { total, items } = summarize(await loadCart(req.user.id));
  if (!items.length) return res.status(400).json({ error: 'Your cart is empty' });

  const code = await createPaymentOtp(req.user.id);
  const amount = formatPrice(total);
  await mailer.sendMail({
    to: rows[0].email,
    subject: `${code} is your Veyra payment code`,
    text: `Hi ${rows[0].name}, use ${code} to confirm your payment of ${amount}. It expires in ${otpTtlMinutes} minutes. Never share this code with anyone.`,
    html: `<p>Hi ${rows[0].name},</p><p>Use this code to confirm your payment of <b>${amount}</b>:</p>
           <p style="font-size:28px;letter-spacing:6px;font-weight:bold">${code}</p>
           <p>It expires in ${otpTtlMinutes} minutes. Never share this code with anyone, including Veyra staff.</p>`,
  });

  res.json({
    sentTo: maskEmail(rows[0].email),
    expiresInSeconds: otpTtlMinutes * 60,
    // Local development without SMTP: hand the code back so the flow can be tested
    ...(!mailer.isConfigured && !isProduction ? { devCode: code } : {}),
  });
};

// POST /api/orders  { addressId | address, paymentMethod, otp? } - turns the user's cart into an order
exports.checkout = async (req, res) => {
  const { addressId, paymentMethod = 'cod', otp } = req.body;
  let { address } = req.body;

  if (addressId) {
    const { rows } = await pool.query('SELECT * FROM addresses WHERE id = $1 AND user_id = $2', [addressId, req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Address not found' });
    address = formatAddress(rows[0]);
  }
  if (!address || !String(address).trim()) return res.status(400).json({ error: 'Shipping address is required' });
  if (!PAYMENT_METHODS.includes(paymentMethod)) return res.status(400).json({ error: 'Unsupported payment method' });

  const cart = await loadCart(req.user.id);
  const { items, total, deliveryFee } = summarize(cart);
  if (!items.length) return res.status(400).json({ error: 'Your cart is empty' });

  for (const i of cart.items) {
    if (i.product.stock < i.qty) return res.status(409).json({ error: `Only ${i.product.stock} left of ${i.product.name}` });
  }

  if (ONLINE_METHODS.includes(paymentMethod)) await verifyPaymentOtp(req.user.id, otp);

  // TODO: for 'upi' / 'card', charge via a payment gateway (Razorpay / Stripe) before committing
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO orders (user_id, total, address, payment_method, delivery_fee) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [req.user.id, total, String(address).trim(), paymentMethod, deliveryFee]
    );
    const order = rows[0];
    for (const i of items) {
      await client.query(
        'INSERT INTO order_items (order_id, product_id, name, price, qty, image) VALUES ($1, $2, $3, $4, $5, $6)',
        [order.id, String(i.productId), i.name, i.price, i.qty, i.image]
      );
    }
    await client.query('COMMIT');

    await Promise.all(cart.items.map((i) => Product.updateOne({ _id: i.product._id }, { $inc: { stock: -i.qty } })));
    cart.items = [];
    await cart.save();

    res.status(201).json({ ...order, items });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const ORDERS_SQL = `
  SELECT o.*, COALESCE(json_agg(oi.* ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
    FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
   WHERE o.user_id = $1`;

exports.list = async (req, res) => {
  const { rows } = await pool.query(`${ORDERS_SQL} GROUP BY o.id ORDER BY o.created_at DESC`, [req.user.id]);
  res.json(rows);
};

exports.get = async (req, res) => {
  const { rows } = await pool.query(`${ORDERS_SQL} AND o.id = $2 GROUP BY o.id`, [req.user.id, Number(req.params.id) || 0]);
  if (!rows[0]) return res.status(404).json({ error: 'Order not found' });
  res.json(rows[0]);
};

// PATCH /api/orders/:id/cancel - cancels a placed order and puts the stock back
exports.cancel = async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE orders SET status = 'cancelled' WHERE id = $1 AND user_id = $2 AND status = 'placed' RETURNING *`,
    [Number(req.params.id) || 0, req.user.id]
  );
  if (!rows[0]) return res.status(400).json({ error: 'This order cannot be cancelled' });

  const items = await pool.query('SELECT product_id, qty FROM order_items WHERE order_id = $1', [rows[0].id]);
  await Promise.all(items.rows.map((i) => Product.updateOne({ _id: i.product_id }, { $inc: { stock: i.qty } }).catch(() => null)));
  res.json(rows[0]);
};
