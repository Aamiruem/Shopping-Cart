const mongoose = require('mongoose');
const { mongoUri } = require('./env');

module.exports = async function connectMongo() {
  await mongoose.connect(mongoUri);
  console.log('MongoDB connected');
};
