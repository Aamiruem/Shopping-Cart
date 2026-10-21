const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { corsOrigin } = require('./config/env');

const app = express();
app.set('trust proxy', 1); // correct req.ip behind nginx / a load balancer (used by the rate limiter)
app.use(cors({ origin: corsOrigin.split(',').map((o) => o.trim()) }));
app.use(express.json({ limit: '100kb' }));
app.use(morgan('dev'));

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/products', require('./routes/products'));
app.use('/api/cart', require('./routes/cart'));
app.use('/api/wishlist', require('./routes/wishlist'));
app.use('/api/addresses', require('./routes/addresses'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/ai', require('./routes/ai'));

app.use('/api', (req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` }));
app.use(require('./middleware/errorHandler'));

module.exports = app;
