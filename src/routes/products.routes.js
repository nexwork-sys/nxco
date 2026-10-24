const express = require('express');
const { query, queryOne, run } = require('../config/db');
const { requireLogin, requireRole, sendJson } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { productJson } = require('../utils/serializers');

const router = express.Router();

router.use(requireLogin);

// GET /api/products — any logged-in role (Marketing/Driver need it to build order/delivery views)
router.get(
    '/',
    asyncHandler(async (req, res) => {
        const products = await query('SELECT * FROM products ORDER BY brand_name ASC, product_name ASC');
        sendJson(res, true, '', { products: products.map(productJson) });
    })
);

// Admin or Supervisor/Manager/Operator manage inventory.
const canManage = requireRole('Admin', 'Supervisor', 'Manager', 'Operator');

router.post(
    '/',
    canManage,
    asyncHandler(async (req, res) => {
        const { brand_name, product_name, quantity, rate } = req.body || {};
        if (!brand_name || !product_name) {
            return sendJson(res, false, 'Brand and product name are required.', {}, 422);
        }
        const result = await run('INSERT INTO products (brand_name, product_name, quantity, rate) VALUES (?, ?, ?, ?)', [
            brand_name.trim(),
            product_name.trim(),
            Math.max(0, Math.floor(Number(quantity) || 0)),
            rate !== undefined && rate !== '' && rate !== null ? Number(rate) : null,
        ]);
        sendJson(res, true, 'Product added.', { id: result.insertId });
    })
);

router.post(
    '/:id/update',
    canManage,
    asyncHandler(async (req, res) => {
        const product = await queryOne('SELECT * FROM products WHERE id = ?', [req.params.id]);
        if (!product) return sendJson(res, false, 'Product not found.', {}, 404);

        const { brand_name, product_name, quantity, rate } = req.body || {};
        await run('UPDATE products SET brand_name = ?, product_name = ?, quantity = ?, rate = ? WHERE id = ?', [
            brand_name ? brand_name.trim() : product.brand_name,
            product_name ? product_name.trim() : product.product_name,
            quantity !== undefined ? Math.max(0, Math.floor(Number(quantity) || 0)) : product.quantity,
            rate !== undefined ? (rate === '' || rate === null ? null : Number(rate)) : product.rate,
            product.id,
        ]);
        sendJson(res, true, 'Product updated.');
    })
);

// POST /api/products/:id/add-stock — adds on top of the current stock (a new delivery arrives).
router.post(
    '/:id/add-stock',
    canManage,
    asyncHandler(async (req, res) => {
        const addQty = Number(req.body?.quantity);
        if (!Number.isFinite(addQty) || addQty <= 0) {
            return sendJson(res, false, 'Enter a valid quantity to add.', {}, 422);
        }
        const result = await run('UPDATE products SET quantity = quantity + ? WHERE id = ?', [Math.floor(addQty), req.params.id]);
        if (result.affectedRows === 0) return sendJson(res, false, 'Product not found.', {}, 404);

        const product = await queryOne('SELECT quantity FROM products WHERE id = ?', [req.params.id]);
        sendJson(res, true, 'Stock updated.', { quantity: product.quantity });
    })
);

router.post(
    '/:id/delete',
    requireRole('Admin'),
    asyncHandler(async (req, res) => {
        const result = await run('DELETE FROM products WHERE id = ?', [req.params.id]);
        if (result.affectedRows === 0) return sendJson(res, false, 'Product not found.', {}, 404);
        sendJson(res, true, 'Product deleted.');
    })
);

module.exports = router;
