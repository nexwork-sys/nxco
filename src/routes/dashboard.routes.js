const express = require('express');
const { query, queryOne } = require('../config/db');
const { requireLogin, requireRole, sendJson } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { todayIST } = require('../utils/dateIST');

const router = express.Router();
router.use(requireLogin);

// GET /api/dashboard/stats — the Overview stat boxes: attendance today, orders in the pipeline vs
// Completed, approved party count, and this month's target progress.
router.get(
    '/stats',
    requireRole('Admin'),
    asyncHandler(async (req, res) => {
        const [present, parties, orderCounts] = await Promise.all([
            queryOne('SELECT COUNT(*) AS n FROM attendance WHERE date = ?', [todayIST()]),
            queryOne("SELECT COUNT(*) AS n FROM parties WHERE status = 'Approved'"),
            queryOne(
                `SELECT COUNT(*) AS total,
                        COALESCE(SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END), 0) AS completed,
                        COALESCE(SUM(CASE WHEN status NOT IN ('Completed', 'Cancelled') THEN 1 ELSE 0 END), 0) AS current
                   FROM orders`
            ),
        ]);

        // Target overview for the current month — total target quantity across every Marketing
        // employee, how much has been achieved via orders so far, and how much is pending.
        const month = todayIST().slice(0, 7);
        const targets = await query('SELECT * FROM targets WHERE month = ?', [month]);
        let target_total = 0;
        let target_achieved = 0;
        for (const t of targets) {
            target_total += t.quantity_target;
            const from = new Date(`${t.start_date}T00:00:00+05:30`);
            const to = new Date(`${t.end_date}T23:59:59.999+05:30`);
            const row = await queryOne(
                `SELECT COALESCE(SUM(oi.quantity), 0) AS qty
                   FROM orders o JOIN order_items oi ON oi.order_id = o.id
                  WHERE o.created_by = ? AND o.status <> 'Cancelled' AND o.created_at BETWEEN ? AND ?`,
                [t.assigned_to, from, to]
            );
            target_achieved += Number(row.qty) || 0;
        }

        sendJson(res, true, '', {
            present_today: present.n,
            total_parties: parties.n,
            current_orders: Number(orderCounts.current),
            completed_orders: Number(orderCounts.completed),
            total_orders: orderCounts.total,
            target_total,
            target_achieved,
            target_remaining: Math.max(0, target_total - target_achieved),
            target_employee_count: targets.length,
        });
    })
);

module.exports = router;
