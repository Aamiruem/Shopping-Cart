const { Schema, model } = require('mongoose');

const productSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    category: { type: String, index: true },     // top-level: mobiles, fashion, ...
    subCategory: { type: String, default: '' },
    brand: { type: String, default: '', index: true },
    tags: [String],
    price: { type: Number, required: true, min: 0 }, // selling price (INR)
    mrp: { type: Number, min: 0 },                   // list price before discount
    rating: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0 },
    stock: { type: Number, default: 0, min: 0 },
    image: String,
    images: [String],
    featured: { type: Boolean, default: false },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

productSchema.virtual('discount').get(function discount() {
  if (!this.mrp || this.mrp <= this.price) return 0;
  return Math.round(((this.mrp - this.price) / this.mrp) * 100);
});

productSchema.index({ name: 'text', description: 'text', tags: 'text' });

module.exports = model('Product', productSchema);
