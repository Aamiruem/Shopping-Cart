// Small in-memory rate limiter (per IP + route). Good enough for a single
// instance; swap for a Redis-backed limiter when running several replicas.
module.exports = function rateLimit({ windowMs = 15 * 60 * 1000, max = 20, message } = {}) {
  const hits = new Map();

  return (req, res, next) => {
    const key = `${req.ip}:${req.baseUrl}${req.path}`;
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (++entry.count > max) {
      res.set('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      return res.status(429).json({ error: message || 'Too many attempts. Please try again later.' });
    }
    next();
  };
};
