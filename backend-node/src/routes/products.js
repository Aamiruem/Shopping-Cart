const router = require('express').Router();
const h = require('../middleware/asyncHandler');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const c = require('../controllers/productController');

router.get('/', h(c.list));
router.get('/categories', h(c.categories)); // before /:id so it isn't read as an id
router.get('/facets', h(c.facets));
router.get('/:id', h(c.get));
router.post('/', requireAuth, requireAdmin, h(c.create));
router.put('/:id', requireAuth, requireAdmin, h(c.update));
router.delete('/:id', requireAuth, requireAdmin, h(c.remove));

module.exports = router;
