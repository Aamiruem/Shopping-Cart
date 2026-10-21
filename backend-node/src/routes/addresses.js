const router = require('express').Router();
const h = require('../middleware/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const c = require('../controllers/addressController');

router.use(requireAuth);
router.get('/', h(c.list));
router.post('/', h(c.create));
router.delete('/:id', h(c.remove));

module.exports = router;
