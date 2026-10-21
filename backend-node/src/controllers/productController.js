const Product = require('../models/Product');

const SORTS = {
  relevance: { featured: -1, rating: -1 },
  popularity: { ratingCount: -1 },
  price_asc: { price: 1 },
  price_desc: { price: -1 },
  rating: { rating: -1 },
  newest: { createdAt: -1 },
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Shared by list and facets so both see the same search + category scope
function baseFilter({ q, category }) {
  const filter = {};
  if (q) {
    const re = new RegExp(escapeRegex(String(q).trim()), 'i');
    filter.$or = [{ name: re }, { brand: re }, { category: re }, { subCategory: re }, { tags: re }];
  }
  if (category) filter.category = category;
  return filter;
}

// GET /api/products?q=&category=&brand=a,b&minPrice=&maxPrice=&minRating=&sort=&featured=&limit=
// Returns a plain array (the AI service depends on this shape).
exports.list = async (req, res) => {
  const { brand, minPrice, maxPrice, minRating, sort = 'relevance', featured } = req.query;
  const filter = baseFilter(req.query);

  if (brand) filter.brand = { $in: String(brand).split(',') };
  if (minPrice || maxPrice) {
    filter.price = {};
    if (minPrice) filter.price.$gte = Number(minPrice);
    if (maxPrice) filter.price.$lte = Number(maxPrice);
  }
  if (minRating) filter.rating = { $gte: Number(minRating) };
  if (featured === 'true') filter.featured = true;

  const limit = Math.min(Number(req.query.limit) || 200, 200);
  res.json(await Product.find(filter).sort(SORTS[sort] || SORTS.relevance).limit(limit));
};

// GET /api/products/categories - category list with product counts and a cover image
exports.categories = async (req, res) => {
  const rows = await Product.aggregate([
    { $sort: { rating: -1 } },
    { $group: { _id: '$category', count: { $sum: 1 }, image: { $first: '$image' } } },
    { $sort: { _id: 1 } },
  ]);
  res.json(rows.map(({ _id, count, image }) => ({ id: _id, count, image })));
};

// GET /api/products/facets?q=&category= - brands and price range for the filter sidebar
exports.facets = async (req, res) => {
  const filter = baseFilter(req.query);
  const [brands, [range = { min: 0, max: 0 }]] = await Promise.all([
    Product.distinct('brand', filter),
    Product.aggregate([{ $match: filter }, { $group: { _id: null, min: { $min: '$price' }, max: { $max: '$price' } } }]),
  ]);
  res.json({ brands: brands.filter(Boolean).sort(), minPrice: range.min, maxPrice: range.max });
};

exports.get = async (req, res) => {
  const product = await Product.findById(req.params.id).catch(() => null);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json(product);
};

exports.create = async (req, res) => res.status(201).json(await Product.create(req.body));

exports.update = async (req, res) => {
  const product = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json(product);
};

exports.remove = async (req, res) => {
  await Product.findByIdAndDelete(req.params.id);
  res.status(204).end();
};
