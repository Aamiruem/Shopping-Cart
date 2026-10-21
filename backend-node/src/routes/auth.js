const router = require('express').Router();
const h = require('../middleware/asyncHandler');
const rateLimit = require('../middleware/rateLimit');
const { requireAuth } = require('../middleware/auth');
const c = require('../controllers/authController');

const authLimiter = rateLimit({ max: 20, message: 'Too many login attempts. Please try again in 15 minutes.' });

router.get('/config', c.config);
router.post('/register', authLimiter, h(c.register));
router.post('/login', authLimiter, h(c.login));
router.post('/google', authLimiter, h(c.google));
router.get('/me', requireAuth, h(c.me));
router.put('/me', requireAuth, h(c.updateProfile));
router.put('/password', requireAuth, authLimiter, h(c.changePassword));

module.exports = router;
