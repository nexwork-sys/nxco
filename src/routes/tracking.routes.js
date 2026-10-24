const express = require('express');
const { query, run } = require('../config/db');
const { requireLogin, requireRole, sendJson } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { todayIST } = require('../utils/dateIST');

const router = express.Router();
router.use(requireLogin);

// POST /api/tracking/ping  { lat, lng } — any checked-in field role calls this periodically while active.
router.post(
    '/ping',
    asyncHandler(async (req, res) => {
        const { lat, lng } = req.body || {};
        if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
            return sendJson(res, false, 'lat/lng required.', {}, 422);
        }
        await run('UPDATE users SET lat = ?, lng = ?, location_updated_at = UTC_TIMESTAMP() WHERE id = ?', [
            Number(lat),
            Number(lng),
            req.user.id,
        ]);
        sendJson(res, true, 'Location updated.');
    })
);

// GET /api/tracking/live — Admin only. Everyone checked in today who hasn't checked out yet.
router.get(
    '/live',
    requireRole('Admin'),
    asyncHandler(async (req, res) => {
        const rows = await query(
            `SELECT u.id, u.employee_id, u.name, u.designation, u.role, u.lat, u.lng,
                    u.location_updated_at AS updated_at, a.time_in, a.time_out
               FROM attendance a
               JOIN users u ON u.id = a.user_id
              WHERE a.date = ? AND a.time_out IS NULL
              ORDER BY u.name ASC`,
            [todayIST()]
        );
        sendJson(res, true, '', { active_employees: rows });
    })
);

module.exports = router;
