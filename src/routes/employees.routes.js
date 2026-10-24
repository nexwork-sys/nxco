const express = require('express');
const bcrypt = require('bcryptjs');
const { query, queryOne, run } = require('../config/db');
const { requireLogin, requireRole, sendJson } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { userJson } = require('../utils/serializers');
const { ROLES } = require('../models/constants');

const router = express.Router();

// Every route in this file is Admin-only.
router.use(requireLogin, requireRole('Admin'));

// GET /api/employees
router.get(
    '/',
    asyncHandler(async (req, res) => {
        const employees = await query('SELECT * FROM users ORDER BY name ASC');
        sendJson(res, true, '', { employees: employees.map(userJson) });
    })
);

// POST /api/employees  { employee_id, name, mobile, designation, role, password }
router.post(
    '/',
    asyncHandler(async (req, res) => {
        const { employee_id, name, mobile, designation, role, password } = req.body || {};
        if (!employee_id || !name || !mobile || !designation || !role || !password) {
            return sendJson(res, false, 'All fields are required.', {}, 422);
        }
        if (!ROLES.includes(role)) return sendJson(res, false, 'Invalid role.', {}, 422);

        const exists = await queryOne('SELECT id FROM users WHERE employee_id = ?', [employee_id.trim()]);
        if (exists) return sendJson(res, false, 'That Employee ID is already in use.', {}, 409);

        const result = await run(
            'INSERT INTO users (employee_id, name, mobile, designation, role, password_hash) VALUES (?, ?, ?, ?, ?, ?)',
            [employee_id.trim(), name.trim(), mobile.trim(), designation.trim(), role, await bcrypt.hash(password, 10)]
        );
        sendJson(res, true, 'Employee created.', { id: result.insertId });
    })
);

// POST /api/employees/:id/update  { name, mobile, designation, role, password? }
router.post(
    '/:id/update',
    asyncHandler(async (req, res) => {
        const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.params.id]);
        if (!user) return sendJson(res, false, 'Employee not found.', {}, 404);

        const { name, mobile, designation, role, password } = req.body || {};
        if (role && !ROLES.includes(role)) return sendJson(res, false, 'Invalid role.', {}, 422);

        await run(
            'UPDATE users SET name = ?, mobile = ?, designation = ?, role = ?, password_hash = ? WHERE id = ?',
            [
                name ? name.trim() : user.name,
                mobile ? mobile.trim() : user.mobile,
                designation ? designation.trim() : user.designation,
                role || user.role,
                password ? await bcrypt.hash(password, 10) : user.password_hash,
                user.id,
            ]
        );
        sendJson(res, true, 'Employee updated.');
    })
);

// POST /api/employees/:id/delete
router.post(
    '/:id/delete',
    asyncHandler(async (req, res) => {
        const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.params.id]);
        if (!user) return sendJson(res, false, 'Employee not found.', {}, 404);
        if (user.employee_id === 'admin') {
            return sendJson(res, false, 'The default admin account cannot be deleted.', {}, 403);
        }
        await run('DELETE FROM users WHERE id = ?', [user.id]);
        sendJson(res, true, 'Employee deleted.');
    })
);

module.exports = router;
