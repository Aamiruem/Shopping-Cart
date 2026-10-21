const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const c = require('../controllers/aiController');

router.get('/recommend/:productId', c.recommend);
router.post('/ask', c.ask);
router.post('/agent', requireAuth, c.agent);

module.exports = router;
