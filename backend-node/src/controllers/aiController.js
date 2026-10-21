const { aiServiceUrl } = require('../config/env');

// Forwards a request to the Python AI service, passing the user's token through
// so the shopping agent can act on the user's own cart.
async function forward(req, res, path, init = {}) {
  try {
    const response = await fetch(`${aiServiceUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: req.headers.authorization || '' },
    });
    res.status(response.status).json(await response.json());
  } catch {
    res.status(502).json({ error: 'AI service is unavailable' });
  }
}

exports.recommend = (req, res) =>
  forward(req, res, `/recommend/${encodeURIComponent(req.params.productId)}?k=${Number(req.query.k) || 4}`);

exports.ask = (req, res) => forward(req, res, '/rag/ask', { method: 'POST', body: JSON.stringify(req.body) });

exports.agent = (req, res) => forward(req, res, '/agent/chat', { method: 'POST', body: JSON.stringify(req.body) });
