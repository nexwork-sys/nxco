const express = require('express');
const { queryOne, run } = require('../config/db');
const { requireLogin, requireRole, sendJson } = require('../middleware/auth');
const { makeUploader, uploadToCloudinary, deleteFromCloudinary } = require('../middleware/upload');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
const uploadLogo = makeUploader(['.jpg', '.jpeg', '.png', '.svg', '.webp']);

router.use(requireLogin);

/** The single settings row (id = 1) — created with defaults on first access so callers never null-check. */
async function getSettings() {
    let row = await queryOne('SELECT * FROM company_settings WHERE id = 1');
    if (!row) {
        await run('INSERT INTO company_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
        row = await queryOne('SELECT * FROM company_settings WHERE id = 1');
    }
    return row;
}

const settingsJson = s => ({
    id: s.id,
    company_lat: s.company_lat,
    company_lng: s.company_lng,
    allowed_radius_meters: s.allowed_radius_meters,
    logo_path: s.logo_path,
});

// GET /api/settings — any logged-in user (needed for geofence checks & branding client-side)
router.get(
    '/',
    asyncHandler(async (req, res) => {
        sendJson(res, true, '', { settings: settingsJson(await getSettings()) });
    })
);

// POST /api/settings — Admin only. Accepts multipart (logo_file) and/or JSON location fields.
router.post(
    '/',
    requireRole('Admin'),
    uploadLogo.single('logo_file'),
    asyncHandler(async (req, res) => {
        const settings = await getSettings();
        const body = req.body || {};

        let logo_path = settings.logo_path;
        if (req.file) {
            const url = await uploadToCloudinary(req.file, 'branding');
            if (url) {
                await deleteFromCloudinary(settings.logo_path);
                logo_path = url;
            }
        }

        await run(
            'UPDATE company_settings SET company_lat = ?, company_lng = ?, allowed_radius_meters = ?, logo_path = ? WHERE id = 1',
            [
                body.company_lat !== undefined ? Number(body.company_lat) : settings.company_lat,
                body.company_lng !== undefined ? Number(body.company_lng) : settings.company_lng,
                body.allowed_radius_meters !== undefined ? Number(body.allowed_radius_meters) : settings.allowed_radius_meters,
                logo_path,
            ]
        );
        sendJson(res, true, 'Settings updated.', { logo_path });
    })
);

module.exports = router;
module.exports.getSettings = getSettings;
