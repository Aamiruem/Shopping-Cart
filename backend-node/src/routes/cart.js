const router = require('express').Router();
const h = require('../middleware/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const c = require('../controllers/cartController');

router.use(requireAuth);
router.get('/', h(c.get));
router.post('/', h(c.add));
router.put('/:productId', h(c.update));
router.delete('/:productId', h(c.remove));

module.exports = router;
