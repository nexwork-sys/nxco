const express = require('express');
const { queryOne, run } = require('../config/db');
const { requireLogin, requireRole, sendJson } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { todayIST } = require('../utils/dateIST');

const router = express.Router();
router.use(requireLogin);

// POST /api/visits  { party_id, note } — "Revisit": logs what happened on this visit.
// Becomes the party's new Last Visit (GET /api/parties attaches the latest one per party).
router.post(
    '/',
    requireRole('Marketing', 'Admin', 'Manager'),
    asyncHandler(async (req, res) => {
        const { party_id, note } = req.body || {};
        if (!party_id) return sendJson(res, false, 'Select a party first.', {}, 422);

        const party = await queryOne('SELECT id FROM parties WHERE id = ?', [party_id]);
        if (!party) return sendJson(res, false, 'Party not found.', {}, 404);

        await run('INSERT INTO visits (party_id, visited_by, note, date) VALUES (?, ?, ?, ?)', [
            party_id,
            req.user.id,
            (note || '').trim(),
            todayIST(),
        ]);
        sendJson(res, true, 'Visit logged.');
    })
);

module.exports = router;
