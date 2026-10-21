// Catches errors passed to next() or thrown in async handlers
module.exports = (err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  if (err.name === 'ValidationError' || err.name === 'CastError') return res.status(400).json({ error: err.message });

  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong. Please try again.' : err.message });
};
