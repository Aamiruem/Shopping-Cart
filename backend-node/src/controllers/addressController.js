const { pool } = require('../config/postgres');

const FIELDS = ['name', 'phone', 'line1', 'city', 'state', 'pincode'];

function validate(body) {
  for (const f of FIELDS) if (!String(body[f] || '').trim()) return `${f === 'line1' ? 'Address' : f} is required`;
  if (!/^[6-9]\d{9}$/.test(String(body.phone).trim())) return 'Please enter a valid 10-digit mobile number';
  if (!/^\d{6}$/.test(String(body.pincode).trim())) return 'Please enter a valid 6-digit pincode';
  return null;
}

exports.list = async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM addresses WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json(rows);
};

exports.create = async (req, res) => {
  const error = validate(req.body);
  if (error) return res.status(400).json({ error });
  const values = FIELDS.map((f) => String(req.body[f]).trim());
  const type = req.body.type === 'work' ? 'work' : 'home';
  const { rows } = await pool.query(
    `INSERT INTO addresses (user_id, ${FIELDS.join(', ')}, type) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [req.user.id, ...values, type]
  );
  res.status(201).json(rows[0]);
};

exports.remove = async (req, res) => {
  await pool.query('DELETE FROM addresses WHERE id = $1 AND user_id = $2', [Number(req.params.id) || 0, req.user.id]);
  res.status(204).end();
};
