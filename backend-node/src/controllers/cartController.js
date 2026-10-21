const Cart = require('../models/Cart');
const Product = require('../models/Product');

const MAX_QTY = 10;              // per line, like most marketplaces
const FREE_DELIVERY_ABOVE = 499;
const DELIVERY_FEE = 40;

async function loadCart(userId) {
  const cart = (await Cart.findOne({ userId }).populate('items.product')) || new Cart({ userId, items: [] });
  // Drop lines whose product was deleted
  cart.items = cart.items.filter((i) => i.product);
  return cart;
}

// Price breakdown shown on the cart and checkout pages
function summarize(cart) {
  const items = cart.items.map((i) => {
    const p = i.product;
    const mrp = p.mrp && p.mrp > p.price ? p.mrp : p.price;
    return {
      productId: p._id,
      name: p.name,
      brand: p.brand,
      image: p.image,
      price: p.price,
      mrp,
      stock: p.stock,
      qty: i.qty,
      subtotal: p.price * i.qty,
    };
  });
  const totalMrp = items.reduce((sum, i) => sum + i.mrp * i.qty, 0);
  const subtotal = items.reduce((sum, i) => sum + i.subtotal, 0);
  const deliveryFee = !items.length || subtotal >= FREE_DELIVERY_ABOVE ? 0 : DELIVERY_FEE;
  return { items, totalMrp, discount: totalMrp - subtotal, subtotal, deliveryFee, total: subtotal + deliveryFee };
}

const clampQty = (qty, stock) => Math.max(1, Math.min(Math.floor(Number(qty) || 1), MAX_QTY, stock));

exports.loadCart = loadCart;
exports.summarize = summarize;

exports.get = async (req, res) => res.json(summarize(await loadCart(req.user.id)));

// POST /api/cart  { productId, qty }
exports.add = async (req, res) => {
  const { productId, qty = 1 } = req.body;
  const product = await Product.findById(productId).catch(() => null);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  if (product.stock < 1) return res.status(409).json({ error: `${product.name} is out of stock` });

  const cart = await loadCart(req.user.id);
  const line = cart.items.find((i) => i.product._id.equals(product._id));
  if (line) line.qty = clampQty(line.qty + Number(qty), product.stock);
  else cart.items.push({ product, qty: clampQty(qty, product.stock) });
  await cart.save();
  res.status(201).json(summarize(await loadCart(req.user.id)));
};

// PUT /api/cart/:productId  { qty }  - qty 0 removes the line
exports.update = async (req, res) => {
  const cart = await loadCart(req.user.id);
  const line = cart.items.find((i) => i.product._id.equals(req.params.productId));
  if (!line) return res.status(404).json({ error: 'Item not in cart' });
  const qty = Number(req.body.qty);
  if (qty <= 0) cart.items.pull(line._id);
  else line.qty = clampQty(qty, line.product.stock);
  await cart.save();
  res.json(summarize(await loadCart(req.user.id)));
};

exports.remove = async (req, res) => {
  const cart = await loadCart(req.user.id);
  cart.items = cart.items.filter((i) => !i.product._id.equals(req.params.productId));
  await cart.save();
  res.json(summarize(await loadCart(req.user.id)));
};
