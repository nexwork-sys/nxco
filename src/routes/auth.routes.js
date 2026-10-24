const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { queryOne, run } = require('../config/db');
const { requireLogin, sendJson } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { userJson } = require('../utils/serializers');

const router = express.Router();

// Per-role landing screen so the mobile app can route straight to the right dashboard after login.
const ROLE_HOME = {
    Admin: 'AdminHome',
    Marketing: 'MarketingHome',
    Supervisor: 'SupervisorHome',
    Manager: 'SupervisorHome',
    Operator: 'SupervisorHome',
    Driver: 'DriverHome',
};

function signToken(user) {
    return jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN || '30d',
    });
}

// POST /api/auth/login  { employee_id, password }
router.post(
    '/login',
    asyncHandler(async (req, res) => {
        const { employee_id, password } = req.body || {};
        if (!employee_id || !password) {
            return sendJson(res, false, 'Employee ID and password are required.', {}, 422);
        }

        const user = await queryOne('SELECT * FROM users WHERE employee_id = ? AND active = 1', [employee_id.trim()]);
        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
            return sendJson(res, false, 'Invalid employee ID or password.', {}, 401);
        }

        sendJson(res, true, 'Login successful.', {
            token: signToken(user),
            user: userJson(user),
            home: ROLE_HOME[user.role] || 'AdminHome',
        });
    })
);

// GET /api/auth/me — validates a stored token on app launch.
router.get(
    '/me',
    requireLogin,
    asyncHandler(async (req, res) => {
        sendJson(res, true, '', { user: userJson(req.user) });
    })
);

// POST /api/auth/change-password  { current_password, new_password }
router.post(
    '/change-password',
    requireLogin,
    asyncHandler(async (req, res) => {
        const { current_password, new_password } = req.body || {};
        if (!current_password || !new_password || new_password.length < 6) {
            return sendJson(res, false, 'New password must be at least 6 characters.', {}, 422);
        }
        const ok = await bcrypt.compare(current_password, req.user.password_hash);
        if (!ok) return sendJson(res, false, 'Current password is incorrect.', {}, 401);

        await run('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(new_password, 10), req.user.id]);
        sendJson(res, true, 'Password updated.');
    })
);

module.exports = router;
