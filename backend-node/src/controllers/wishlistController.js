const Wishlist = require('../models/Wishlist');
const Product = require('../models/Product');

async function loadProducts(userId) {
  const list = await Wishlist.findOne({ userId }).populate('products');
  return (list?.products || []).filter(Boolean);
}

exports.get = async (req, res) => res.json(await loadProducts(req.user.id));

// POST /api/wishlist/:productId
exports.add = async (req, res) => {
  const product = await Product.findById(req.params.productId).catch(() => null);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  await Wishlist.updateOne({ userId: req.user.id }, { $addToSet: { products: product._id } }, { upsert: true });
  res.status(201).json(await loadProducts(req.user.id));
};

// DELETE /api/wishlist/:productId
exports.remove = async (req, res) => {
  await Wishlist.updateOne({ userId: req.user.id }, { $pull: { products: req.params.productId } }).catch(() => null);
  res.json(await loadProducts(req.user.id));
};
