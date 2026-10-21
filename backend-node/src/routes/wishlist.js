const router = require('express').Router();
const h = require('../middleware/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const c = require('../controllers/wishlistController');

router.use(requireAuth);
router.get('/', h(c.get));
router.post('/:productId', h(c.add));
router.delete('/:productId', h(c.remove));

module.exports = router;
