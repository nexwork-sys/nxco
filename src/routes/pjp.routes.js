const express = require('express');
const { query, queryOne, withTransaction } = require('../config/db');
const { requireLogin, requireRole, sendJson } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { todayIST } = require('../utils/dateIST');
const { attachRates } = require('../utils/serializers');

const router = express.Router();
router.use(requireLogin);

// Admin or Manager can build a Marketing employee's journey plan.
const canPlan = requireRole('Admin', 'Manager');

// GET /api/pjp/marketing-users — the list to assign a plan to.
router.get(
    '/marketing-users',
    canPlan,
    asyncHandler(async (req, res) => {
        const users = await query(
            "SELECT id, name, employee_id FROM users WHERE role = 'Marketing' AND active = 1 ORDER BY name ASC"
        );
        sendJson(res, true, '', { users });
    })
);

// POST /api/pjp  { assigned_to, party_ids: [...] } — sets/replaces TODAY's plan for that employee.
router.post(
    '/',
    canPlan,
    asyncHandler(async (req, res) => {
        const { assigned_to, party_ids } = req.body || {};
        if (!assigned_to || !Array.isArray(party_ids) || party_ids.length === 0) {
            return sendJson(res, false, 'Select an employee and at least one party.', {}, 422);
        }
        const ids = [...new Set(party_ids.map(Number).filter(Number.isFinite))];
        if (ids.length === 0) return sendJson(res, false, 'Select an employee and at least one party.', {}, 422);
        const date = todayIST();

        await withTransaction(async tx => {
            await tx.run(
                `INSERT INTO pjp (date, assigned_to, created_by) VALUES (?, ?, ?)
                 ON CONFLICT (date, assigned_to) DO UPDATE SET created_by = EXCLUDED.created_by`,
                [date, assigned_to, req.user.id]
            );
            const plan = await tx.queryOne('SELECT id FROM pjp WHERE date = ? AND assigned_to = ?', [date, assigned_to]);
            await tx.run('DELETE FROM pjp_parties WHERE pjp_id = ?', [plan.id]);
            // Only keep parties that still exist.
            const valid = await tx.query('SELECT id FROM parties WHERE id IN (?)', [ids]);
            const validIds = new Set(valid.map(p => p.id));
            for (const pid of ids.filter(i => validIds.has(i))) {
                await tx.run('INSERT INTO pjp_parties (pjp_id, party_id) VALUES (?, ?)', [plan.id, pid]);
            }
        });
        sendJson(res, true, "Today's plan saved.");
    })
);

// GET /api/pjp/today — a Marketing employee's own plan for today, each party flagged as visited today or not.
router.get(
    '/today',
    asyncHandler(async (req, res) => {
        const date = todayIST();
        const plan = await queryOne('SELECT id FROM pjp WHERE date = ? AND assigned_to = ?', [date, req.user.id]);
        if (!plan) return sendJson(res, true, '', { parties: [] });

        const partyRows = await query(
            `SELECT p.* FROM pjp_parties pp JOIN parties p ON p.id = pp.party_id
              WHERE pp.pjp_id = ? ORDER BY pp.id ASC`,
            [plan.id]
        );
        const visits = await query('SELECT DISTINCT party_id FROM visits WHERE visited_by = ? AND date = ?', [req.user.id, date]);
        const visitedIds = new Set(visits.map(v => v.party_id));

        const parties = (await attachRates(partyRows)).map(p => ({ ...p, visited_today: visitedIds.has(p.id) }));
        sendJson(res, true, '', { parties });
    })
);

// GET /api/pjp/status?date=YYYY-MM-DD (defaults to today) — who was planned to visit whom, and did the revisit happen.
// Admin/Manager see everyone's plans (optionally ?user_id=); Marketing only their own.
router.get(
    '/status',
    asyncHandler(async (req, res) => {
        const date = req.query.date || todayIST();
        const where = ['pj.date = ?'];
        const params = [date];
        if (req.user.role === 'Marketing') {
            where.push('pj.assigned_to = ?');
            params.push(req.user.id);
        } else if (req.query.user_id) {
            where.push('pj.assigned_to = ?');
            params.push(req.query.user_id);
        }

        const plans = await query(
            `SELECT pj.id, pj.date, pj.assigned_to, u.name AS employee_name, u.employee_id, c.name AS planned_by
               FROM pjp pj
               JOIN users u ON u.id = pj.assigned_to
               LEFT JOIN users c ON c.id = pj.created_by
              WHERE ${where.join(' AND ')}`,
            params
        );

        const planIds = plans.map(p => p.id);
        const planParties = planIds.length
            ? await query(
                  `SELECT pp.pjp_id, p.id, p.party_name, p.area, p.city
                     FROM pjp_parties pp JOIN parties p ON p.id = pp.party_id
                    WHERE pp.pjp_id IN (?) ORDER BY pp.id ASC`,
                  [planIds]
              )
            : [];
        const visits = await query('SELECT DISTINCT party_id, visited_by FROM visits WHERE date = ?', [date]);
        const visitedKey = new Set(visits.map(v => `${v.visited_by}:${v.party_id}`));

        const rows = plans.map(p => {
            const parties = planParties
                .filter(pp => pp.pjp_id === p.id)
                .map(pp => ({
                    id: pp.id,
                    party_name: pp.party_name,
                    area: pp.area,
                    city: pp.city,
                    visited: visitedKey.has(`${p.assigned_to}:${pp.id}`),
                }));
            const visitedCount = parties.filter(pt => pt.visited).length;
            return {
                id: p.id,
                date: p.date,
                assigned_to: p.assigned_to,
                employee_name: p.employee_name,
                employee_id: p.employee_id,
                planned_by: p.planned_by,
                planned_count: parties.length,
                visited_count: visitedCount,
                pending_count: parties.length - visitedCount,
                parties,
            };
        });
        rows.sort((a, b) => (a.employee_name || '').localeCompare(b.employee_name || ''));

        const summary = rows.reduce(
            (acc, r) => ({
                planned: acc.planned + r.planned_count,
                visited: acc.visited + r.visited_count,
                pending: acc.pending + r.pending_count,
            }),
            { planned: 0, visited: 0, pending: 0 }
        );

        sendJson(res, true, '', { date, plans: rows, summary });
    })
);

module.exports = router;
