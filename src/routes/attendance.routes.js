const express = require('express');
const { query, queryOne, run } = require('../config/db');
const { requireLogin, sendJson } = require('../middleware/auth');
const { getSettings } = require('./settings.routes');
const asyncHandler = require('../utils/asyncHandler');
const { haversineDistanceMeters } = require('../utils/distance');
const { todayIST, nowTimeIST } = require('../utils/dateIST');

const router = express.Router();
const MARKETING_RADIUS_METERS = 1000; // must be near the party's shop

router.use(requireLogin);

// POST /api/attendance/mark  { type: 'in'|'out', lat, lng, party_id? }
router.post(
    '/mark',
    asyncHandler(async (req, res) => {
        const { type, lat, lng, party_id } = req.body || {};
        if (!['in', 'out'].includes(type) || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
            return sendJson(res, false, 'Location and check-in/out type are required.', {}, 422);
        }

        if (type === 'in') {
            if (req.user.role === 'Marketing') {
                if (!party_id) {
                    return sendJson(
                        res,
                        false,
                        'Select the party you are visiting first. If it\'s a new shop, add it under "Add Party" and save it — then come back here and select it to mark attendance.',
                        {},
                        422
                    );
                }
                const party = await queryOne('SELECT * FROM parties WHERE id = ?', [party_id]);
                if (!party) return sendJson(res, false, 'Selected party not found.', {}, 404);
                const distance = haversineDistanceMeters(Number(lat), Number(lng), party.lat, party.lng);
                if (distance > MARKETING_RADIUS_METERS) {
                    return sendJson(
                        res,
                        false,
                        `You are ${Math.round(distance)}m away from ${party.party_name}. Move within ${MARKETING_RADIUS_METERS}m of the shop to mark attendance.`,
                        {},
                        403
                    );
                }
            } else if (['Supervisor', 'Manager', 'Operator', 'Driver'].includes(req.user.role)) {
                const settings = await getSettings();
                const distance = haversineDistanceMeters(Number(lat), Number(lng), settings.company_lat, settings.company_lng);
                if (distance > settings.allowed_radius_meters) {
                    return sendJson(
                        res,
                        false,
                        `You are ${Math.round(distance)}m away from the office. Move within ${settings.allowed_radius_meters}m to check in.`,
                        {},
                        403
                    );
                }
            }
        }

        const date = todayIST();
        const record = await queryOne('SELECT * FROM attendance WHERE user_id = ? AND date = ?', [req.user.id, date]);

        if (type === 'in') {
            if (!record) {
                await run(
                    `INSERT INTO attendance (user_id, date, time_in, attendance_type, lat, lng, party_id)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [
                        req.user.id,
                        date,
                        nowTimeIST(),
                        req.user.role === 'Marketing' ? 'Field' : 'Office',
                        Number(lat),
                        Number(lng),
                        party_id || null,
                    ]
                );
            } else if (record.time_out) {
                // Already checked out today — treat as a fresh check-in (multi-visit days).
                await run(
                    'UPDATE attendance SET time_in = ?, time_out = NULL, lat = ?, lng = ?, party_id = ? WHERE id = ?',
                    [nowTimeIST(), Number(lat), Number(lng), party_id || null, record.id]
                );
            } else {
                return sendJson(res, false, 'You are already checked in.', {}, 409);
            }

            // Update the user's live location too, for the Live Tracking map.
            await run('UPDATE users SET lat = ?, lng = ?, location_updated_at = UTC_TIMESTAMP() WHERE id = ?', [
                Number(lat),
                Number(lng),
                req.user.id,
            ]);
            return sendJson(res, true, 'Check-in recorded.');
        }

        // type === 'out'
        if (!record || !record.time_in || record.time_out) {
            return sendJson(res, false, 'You are not currently checked in.', {}, 409);
        }
        await run('UPDATE attendance SET time_out = ? WHERE id = ?', [nowTimeIST(), record.id]);
        sendJson(res, true, 'Check-out recorded.');
    })
);

// GET /api/attendance/list?date=YYYY-MM-DD or ?from=&to=&search=&user_id=
// Admin sees everyone, others see only their own records.
router.get(
    '/list',
    asyncHandler(async (req, res) => {
        const where = [];
        const params = [];

        if (req.user.role !== 'Admin') {
            where.push('a.user_id = ?');
            params.push(req.user.id);
        } else if (req.query.user_id) {
            where.push('a.user_id = ?');
            params.push(req.query.user_id);
        }

        if (req.query.date) {
            where.push('a.date = ?');
            params.push(req.query.date);
        } else {
            // 'YYYY-MM-DD' strings compare correctly lexicographically.
            if (req.query.from) { where.push('a.date >= ?'); params.push(req.query.from); }
            if (req.query.to) { where.push('a.date <= ?'); params.push(req.query.to); }
        }

        const search = (req.query.search || '').trim().toLowerCase();
        if (search) {
            where.push('(LOWER(u.name) LIKE ? OR LOWER(u.employee_id) LIKE ?)');
            params.push(`%${search}%`, `%${search}%`);
        }

        const records = await query(
            `SELECT a.*, u.name, u.employee_id, u.designation, u.role, p.party_name
               FROM attendance a
               JOIN users u ON u.id = a.user_id
               LEFT JOIN parties p ON p.id = a.party_id
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
              ORDER BY a.date DESC, a.time_in DESC`,
            params
        );

        sendJson(res, true, '', {
            attendance: records.map(a => ({
                id: a.id,
                employee_id: a.employee_id,
                name: a.name,
                designation: a.designation,
                role: a.role,
                date: a.date,
                time_in: a.time_in,
                time_out: a.time_out,
                attendance_type: a.attendance_type,
                // Checked in with no check-out yet = Active, otherwise Inactive.
                status: a.time_in && !a.time_out ? 'Active' : 'Inactive',
                lat: a.lat,
                lng: a.lng,
                party_name: a.party_name || null,
            })),
        });
    })
);

module.exports = router;
