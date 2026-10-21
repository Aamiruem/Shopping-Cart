const { Schema, model } = require('mongoose');

const wishlistSchema = new Schema(
  {
    userId: { type: Number, required: true, unique: true }, // PostgreSQL users.id
    products: [{ type: Schema.Types.ObjectId, ref: 'Product' }],
  },
  { timestamps: true }
);

module.exports = model('Wishlist', wishlistSchema);
