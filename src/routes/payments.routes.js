const express = require('express');
const { query, queryOne, run } = require('../config/db');
const { requireLogin, requireRole, sendJson } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { PAYMENT_METHODS } = require('../models/constants');

const router = express.Router();
router.use(requireLogin);

const round2 = n => Math.round(n * 100) / 100;

/** party_id -> total value ever billed to them (sum of rate × quantity across their Completed orders). */
async function totalBilledByParty(partyId = null) {
    const rows = await query(
        `SELECT o.party_id, SUM(oi.rate * oi.quantity) AS billed
           FROM orders o JOIN order_items oi ON oi.order_id = o.id
          WHERE o.status = 'Completed' ${partyId ? 'AND o.party_id = ?' : ''}
          GROUP BY o.party_id`,
        partyId ? [partyId] : []
    );
    return new Map(rows.map(r => [r.party_id, Number(r.billed)]));
}

/** party_id -> total of every Payment (driver-collected + manual) recorded against them. */
async function totalCollectedByParty() {
    const rows = await query('SELECT party_id, SUM(amount) AS collected FROM payments GROUP BY party_id');
    return new Map(rows.map(r => [r.party_id, Number(r.collected)]));
}

// GET /api/payments/dues — every party's billed / collected / due, for the Party Dashboard "due" badges.
router.get(
    '/dues',
    asyncHandler(async (req, res) => {
        const [billedMap, collectedMap, parties] = await Promise.all([
            totalBilledByParty(),
            totalCollectedByParty(),
            query('SELECT id FROM parties'),
        ]);
        const dues = parties.map(p => {
            const billed = billedMap.get(p.id) || 0;
            const collected = collectedMap.get(p.id) || 0;
            return { party_id: p.id, billed, collected, due: Math.max(0, round2(billed - collected)) };
        });
        sendJson(res, true, '', { dues });
    })
);

// GET /api/payments/party/:partyId — one party's due summary + full payment history, newest first.
router.get(
    '/party/:partyId',
    asyncHandler(async (req, res) => {
        const party = await queryOne('SELECT id FROM parties WHERE id = ?', [req.params.partyId]);
        if (!party) return sendJson(res, false, 'Party not found.', {}, 404);

        const [billedMap, payments] = await Promise.all([
            totalBilledByParty(party.id),
            query(
                `SELECT p.*, u.name AS collected_by_name
                   FROM payments p LEFT JOIN users u ON u.id = p.collected_by
                  WHERE p.party_id = ? ORDER BY p.created_at DESC, p.id DESC`,
                [party.id]
            ),
        ]);
        const billed = billedMap.get(party.id) || 0;
        const collected = payments.reduce((sum, p) => sum + p.amount, 0);

        sendJson(res, true, '', {
            billed,
            collected,
            due: Math.max(0, round2(billed - collected)),
            payments: payments.map(p => ({
                id: p.id,
                amount: p.amount,
                method: p.method,
                note: p.note,
                order_id: p.order_id ?? null,
                collected_by_name: p.collected_by_name || '—',
                created_at: p.created_at,
            })),
        });
    })
);

// POST /api/payments — a manual collection entry against a party's running due
// (party paid cash at the office, over UPI, cleared old due, etc).
router.post(
    '/',
    requireRole('Admin', 'Marketing', 'Manager'),
    asyncHandler(async (req, res) => {
        const { party_id, amount, method, note } = req.body || {};
        const party = party_id ? await queryOne('SELECT id FROM parties WHERE id = ?', [party_id]) : null;
        if (!party) return sendJson(res, false, 'Party not found.', {}, 404);

        const numAmount = Number(amount);
        if (!Number.isFinite(numAmount) || numAmount <= 0) {
            return sendJson(res, false, 'Enter a valid payment amount.', {}, 422);
        }
        if (!PAYMENT_METHODS.includes(method)) {
            return sendJson(res, false, 'Select a payment method.', {}, 422);
        }

        const result = await run('INSERT INTO payments (party_id, amount, method, note, collected_by) VALUES (?, ?, ?, ?, ?)', [
            party.id,
            numAmount,
            method,
            String(note || '').slice(0, 255),
            req.user.id,
        ]);
        sendJson(res, true, 'Payment recorded.', { id: result.insertId });
    })
);

module.exports = router;
