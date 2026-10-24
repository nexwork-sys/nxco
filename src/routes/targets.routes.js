const express = require('express');
const { query, queryOne, run } = require('../config/db');
const { requireLogin, requireRole, sendJson } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { todayIST } = require('../utils/dateIST');

const router = express.Router();
router.use(requireLogin);

/** 'YYYY-MM-DD' (IST) -> the real UTC instants covering that whole IST day range, for created_at queries. */
function istDateRange(startStr, endStr) {
    return [new Date(`${startStr}T00:00:00+05:30`), new Date(`${endStr}T23:59:59.999+05:30`)];
}

/**
 * Achieved quantity = total units ordered by this employee inside the target
 * window. Counts as soon as the order is placed (even Pending) — only
 * Cancelled orders don't count, since their stock was returned. A deleted
 * order disappears from this automatically.
 */
async function achievedQuantity(userId, start_date, end_date) {
    const [from, to] = istDateRange(start_date, end_date);
    const row = await queryOne(
        `SELECT COALESCE(SUM(oi.quantity), 0) AS qty
           FROM orders o JOIN order_items oi ON oi.order_id = o.id
          WHERE o.created_by = ? AND o.status <> 'Cancelled' AND o.created_at BETWEEN ? AND ?`,
        [userId, from, to]
    );
    return Number(row.qty) || 0;
}

function daysLeft(end_date) {
    const today = todayIST();
    return Math.ceil((new Date(`${end_date}T00:00:00+05:30`) - new Date(`${today}T00:00:00+05:30`)) / 86400000);
}

function serialize(t, achieved) {
    const quantity_target = t.quantity_target;
    const remaining = Math.max(0, quantity_target - achieved);
    return {
        id: t.id,
        assigned_to: t.assigned_to,
        employee_name: t.employee_name,
        employee_id: t.employee_id,
        month: t.month,
        quantity_target,
        start_date: t.start_date,
        end_date: t.end_date,
        notes: t.notes || '',
        achieved,
        remaining,
        percent: quantity_target > 0 ? Math.min(100, Math.round((achieved / quantity_target) * 100)) : 0,
        days_left: daysLeft(t.end_date),
        completed: achieved >= quantity_target,
    };
}

const TARGET_SELECT = `SELECT t.*, u.name AS employee_name, u.employee_id
                         FROM targets t JOIN users u ON u.id = t.assigned_to`;

// GET /api/targets — every Marketing employee's target for the given month (defaults to the current month).
router.get(
    '/',
    requireRole('Admin', 'Manager'),
    asyncHandler(async (req, res) => {
        const month = req.query.month || todayIST().slice(0, 7);
        const targets = await query(`${TARGET_SELECT} WHERE t.month = ?`, [month]);
        const rows = await Promise.all(
            targets.map(async t => serialize(t, await achievedQuantity(t.assigned_to, t.start_date, t.end_date)))
        );
        rows.sort((a, b) => (a.employee_name || '').localeCompare(b.employee_name || ''));

        const summary = rows.reduce(
            (acc, r) => ({
                total_target: acc.total_target + r.quantity_target,
                total_achieved: acc.total_achieved + r.achieved,
                total_remaining: acc.total_remaining + r.remaining,
            }),
            { total_target: 0, total_achieved: 0, total_remaining: 0 }
        );

        sendJson(res, true, '', { targets: rows, summary, month });
    })
);

// POST /api/targets  { assigned_to, quantity_target, start_date?, end_date, month?, notes? }
// Sets (or replaces, if one already exists for that employee+month) a target.
router.post(
    '/',
    requireRole('Admin', 'Manager'),
    asyncHandler(async (req, res) => {
        const { assigned_to, quantity_target, end_date, notes } = req.body || {};
        const start_date = req.body?.start_date || todayIST();
        const month = req.body?.month || start_date.slice(0, 7);

        if (!assigned_to || !Number.isFinite(Number(quantity_target)) || Number(quantity_target) <= 0 || !end_date) {
            return sendJson(res, false, 'Select an employee, a total quantity target, and the last date.', {}, 422);
        }
        if (end_date < start_date) {
            return sendJson(res, false, 'The last date must be on or after the start date.', {}, 422);
        }
        const employee = await queryOne("SELECT id, name FROM users WHERE id = ? AND role = 'Marketing'", [assigned_to]);
        if (!employee) return sendJson(res, false, 'Marketing employee not found.', {}, 404);

        await run(
            `INSERT INTO targets (assigned_to, assigned_by, month, quantity_target, start_date, end_date, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (assigned_to, month) DO UPDATE SET assigned_by = EXCLUDED.assigned_by, quantity_target = EXCLUDED.quantity_target,
                                     start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date, notes = EXCLUDED.notes`,
            [assigned_to, req.user.id, month, Number(quantity_target), start_date, end_date, notes || '']
        );
        const target = await queryOne('SELECT id FROM targets WHERE assigned_to = ? AND month = ?', [assigned_to, month]);

        sendJson(res, true, `Target set for ${employee.name}.`, { id: target.id });
    })
);

// DELETE /api/targets/:id — removes a target.
router.delete(
    '/:id',
    requireRole('Admin', 'Manager'),
    asyncHandler(async (req, res) => {
        const result = await run('DELETE FROM targets WHERE id = ?', [req.params.id]);
        if (result.affectedRows === 0) return sendJson(res, false, 'Target not found.', {}, 404);
        sendJson(res, true, 'Target removed.');
    })
);

// GET /api/targets/mine — the logged-in Marketing employee's own current target + live progress.
router.get(
    '/mine',
    asyncHandler(async (req, res) => {
        const month = req.query.month || todayIST().slice(0, 7);
        const target = await queryOne(`${TARGET_SELECT} WHERE t.assigned_to = ? AND t.month = ?`, [req.user.id, month]);
        if (!target) return sendJson(res, true, '', { target: null });
        const achieved = await achievedQuantity(req.user.id, target.start_date, target.end_date);
        sendJson(res, true, '', { target: serialize(target, achieved) });
    })
);

module.exports = router;
