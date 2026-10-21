const { Schema, model } = require('mongoose');

const cartSchema = new Schema(
  {
    userId: { type: Number, required: true, unique: true }, // PostgreSQL users.id
    items: [
      {
        product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
        qty: { type: Number, required: true, min: 1 },
      },
    ],
  },
  { timestamps: true }
);

module.exports = model('Cart', cartSchema);
