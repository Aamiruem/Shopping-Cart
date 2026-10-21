const router = require('express').Router();
const h = require('../middleware/asyncHandler');
const rateLimit = require('../middleware/rateLimit');
const { requireAuth } = require('../middleware/auth');
const c = require('../controllers/orderController');

const otpLimiter = rateLimit({ max: 10, message: 'Too many code requests. Please try again in 15 minutes.' });

router.use(requireAuth);
router.post('/otp', otpLimiter, h(c.requestOtp));
router.post('/', h(c.checkout));
router.get('/', h(c.list));
router.get('/:id', h(c.get));
router.patch('/:id/cancel', h(c.cancel));

module.exports = router;
