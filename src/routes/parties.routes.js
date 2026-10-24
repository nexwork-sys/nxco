const express = require('express');
const PDFDocument = require('pdfkit');
const { query, queryOne, run, withTransaction } = require('../config/db');
const { requireLogin, requireRole, sendJson } = require('../middleware/auth');
const { makeUploader, uploadToCloudinary, deleteFromCloudinary } = require('../middleware/upload');
const asyncHandler = require('../utils/asyncHandler');
const { attachRates } = require('../utils/serializers');
const { VEHICLE_TYPES } = require('../models/constants');

const router = express.Router();
router.use(requireLogin);

// Every image goes to Cloudinary (memory upload -> Cloudinary -> URL stored in PostgreSQL).
const partyImages = makeUploader(['.jpg', '.jpeg', '.png']).fields([
    { name: 'shop_image', maxCount: 1 },
    { name: 'owner_image', maxCount: 1 },
    { name: 'aadhar_image', maxCount: 1 },
    { name: 'pan_image', maxCount: 1 },
]);

// Which Cloudinary sub-folder each image field goes in.
const IMAGE_FOLDERS = { shop_image: 'shops', owner_image: 'shops', aadhar_image: 'kyc', pan_image: 'kyc' };

/** Uploads whichever of the given image fields were sent; resolves to { field: url }. */
async function uploadImageFields(files, fields) {
    const out = {};
    await Promise.all(
        fields.map(async field => {
            const file = files?.[field]?.[0];
            if (file) out[field] = await uploadToCloudinary(file, IMAGE_FOLDERS[field]);
        })
    );
    return out;
}

function parseVehicleTypes(raw) {
    if (raw === undefined) return undefined;
    const list = Array.isArray(raw) ? raw : String(raw).split(',');
    return list.map(v => v.trim()).filter(v => VEHICLE_TYPES.includes(v));
}

/** Parses the fill-form's per-product rates: '[{"product_id":"...","rate":100}, ...]'. */
function parseProductRates(raw) {
    if (raw === undefined) return undefined;
    let list;
    try {
        list = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
        return null;
    }
    if (!Array.isArray(list)) return null;
    for (const r of list) {
        if (!r.product_id || !Number.isFinite(Number(r.rate)) || Number(r.rate) < 0) return null;
    }
    return list.map(r => ({ product_id: Number(r.product_id), rate: Number(r.rate) }));
}

// GET /api/parties — Approved parties by default; Admin/Manager pass ?status=all to include Pending ones;
// anyone can pass ?mine=1 to see just the parties they personally added, at any status.
router.get(
    '/',
    asyncHandler(async (req, res) => {
        let where = "WHERE status = 'Approved'";
        let params = [];
        if (req.query.mine === '1') {
            where = 'WHERE created_by = ?';
            params = [req.user.id];
        } else if (req.query.status === 'all' && ['Admin', 'Manager'].includes(req.user.role)) {
            where = '';
        }
        const partyRows = await query(`SELECT * FROM parties ${where} ORDER BY party_name ASC`, params);
        const parties = await attachRates(partyRows);

        // The most recent Visit per party (with the visitor's name) — "Last Visit" on every party card.
        const lastVisits = await query(
            `SELECT v.party_id, v.date, v.note, u.name AS visited_by_name
               FROM visits v
               JOIN (SELECT party_id, MAX(id) AS last_id FROM visits GROUP BY party_id) m ON m.last_id = v.id
               LEFT JOIN users u ON u.id = v.visited_by`
        );
        const lastVisitByParty = new Map(
            lastVisits.map(v => [v.party_id, { date: v.date, note: v.note || '', visited_by_name: v.visited_by_name || null }])
        );

        sendJson(res, true, '', {
            parties: parties.map(p => ({ ...p, last_visit: lastVisitByParty.get(p.id) || null })),
        });
    })
);

// POST /api/parties — Admin/Manager (auto-approved) or Marketing (Pending until Admin/Manager approves)
router.post(
    '/',
    requireRole('Admin', 'Manager', 'Marketing'),
    partyImages,
    asyncHandler(async (req, res) => {
        const { party_name, owner_name, mobile, water_brand, years_exp, vehicle_types, area, city, address, lat, lng } = req.body || {};
        if (!party_name || !owner_name || !mobile || !lat || !lng) {
            return sendJson(res, false, 'Party name, owner, mobile, and location are required.', {}, 422);
        }
        const autoApprove = ['Admin', 'Manager'].includes(req.user.role);
        const images = await uploadImageFields(req.files, ['shop_image', 'owner_image']);

        let result;
        try {
            result = await run(
                `INSERT INTO parties
                    (party_name, owner_name, mobile, water_brand, years_exp, vehicle_types, area, city, address,
                     shop_image, owner_image, lat, lng, created_by, status, approved_by, approved_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    party_name.trim(),
                    owner_name.trim(),
                    mobile.trim(),
                    water_brand || '',
                    Number(years_exp) || 0,
                    (parseVehicleTypes(vehicle_types) || []).join(','),
                    area || '',
                    city || '',
                    address || '',
                    images.shop_image || null,
                    images.owner_image || null,
                    Number(lat),
                    Number(lng),
                    req.user.id,
                    autoApprove ? 'Approved' : 'Pending',
                    autoApprove ? req.user.id : null,
                    autoApprove ? new Date() : null,
                ]
            );
        } catch (e) {
            await deleteFromCloudinary(Object.values(images)); // don't leave orphaned uploads behind
            throw e;
        }
        sendJson(res, true, autoApprove ? 'Party created.' : 'Party submitted — waiting for Admin/Manager approval.', {
            id: result.insertId,
        });
    })
);

// POST /api/parties/:id/update
router.post(
    '/:id/update',
    requireRole('Admin', 'Manager', 'Marketing'),
    partyImages,
    asyncHandler(async (req, res) => {
        const party = await queryOne('SELECT * FROM parties WHERE id = ?', [req.params.id]);
        if (!party) return sendJson(res, false, 'Party not found.', {}, 404);

        const b = req.body || {};
        const images = await uploadImageFields(req.files, ['shop_image', 'owner_image']);

        await run(
            `UPDATE parties SET party_name = ?, owner_name = ?, mobile = ?, water_brand = ?, area = ?, city = ?, address = ?,
                    years_exp = ?, vehicle_types = ?, lat = ?, lng = ?, shop_image = ?, owner_image = ? WHERE id = ?`,
            [
                b.party_name !== undefined ? b.party_name : party.party_name,
                b.owner_name !== undefined ? b.owner_name : party.owner_name,
                b.mobile !== undefined ? b.mobile : party.mobile,
                b.water_brand !== undefined ? b.water_brand : party.water_brand,
                b.area !== undefined ? b.area : party.area,
                b.city !== undefined ? b.city : party.city,
                b.address !== undefined ? b.address : party.address,
                b.years_exp !== undefined ? Number(b.years_exp) || 0 : party.years_exp,
                b.vehicle_types !== undefined ? (parseVehicleTypes(b.vehicle_types) || []).join(',') : party.vehicle_types,
                b.lat !== undefined ? Number(b.lat) : party.lat,
                b.lng !== undefined ? Number(b.lng) : party.lng,
                images.shop_image || party.shop_image,
                images.owner_image || party.owner_image,
                party.id,
            ]
        );
        // Replaced photos are removed from Cloudinary.
        await deleteFromCloudinary([images.shop_image && party.shop_image, images.owner_image && party.owner_image].filter(Boolean));
        sendJson(res, true, 'Party updated.');
    })
);

// POST /api/parties/:id/approve — Admin/Manager approves a Pending party
router.post(
    '/:id/approve',
    requireRole('Admin', 'Manager'),
    asyncHandler(async (req, res) => {
        const result = await run("UPDATE parties SET status = 'Approved', approved_by = ?, approved_at = UTC_TIMESTAMP() WHERE id = ?", [
            req.user.id,
            req.params.id,
        ]);
        if (result.affectedRows === 0) return sendJson(res, false, 'Party not found.', {}, 404);
        sendJson(res, true, 'Party approved.');
    })
);

// POST /api/parties/:id/fill-form — the KYC form for an Approved party: owner/Aadhar/PAN photos + numbers,
// optional GST, a comment, and this party's negotiated rate for each product. Saving a complete form is what
// unlocks order placement for the party.
//
// NOTE: payment mode (Cash / Credit) and the cheque number + photo are NOT part of this form any more —
// they are chosen on each order, at the time the order is placed (see orders.routes.js).
router.post(
    '/:id/fill-form',
    requireRole('Admin', 'Marketing'),
    partyImages,
    asyncHandler(async (req, res) => {
        const party = await queryOne('SELECT * FROM parties WHERE id = ?', [req.params.id]);
        if (!party) return sendJson(res, false, 'Party not found.', {}, 404);
        if (party.status !== 'Approved') {
            return sendJson(res, false, 'Approve this party first before filling in its form.', {}, 409);
        }

        const b = req.body || {};
        const rates = b.product_rates !== undefined ? parseProductRates(b.product_rates) : undefined;
        if (rates === null) return sendJson(res, false, 'Invalid product rates.', {}, 422);

        const images = await uploadImageFields(req.files, ['owner_image', 'aadhar_image', 'pan_image']);

        const next = {
            aadhar_no: b.aadhar_no !== undefined ? b.aadhar_no : party.aadhar_no,
            pan_no: b.pan_no !== undefined ? b.pan_no : party.pan_no,
            gst_no: b.gst_no !== undefined ? b.gst_no : party.gst_no, // optional
            form_no: b.form_no !== undefined ? b.form_no : party.form_no,
            comment: b.comment !== undefined ? b.comment : party.comment || '',
            owner_image: images.owner_image || party.owner_image,
            aadhar_image: images.aadhar_image || party.aadhar_image,
            pan_image: images.pan_image || party.pan_image,
        };

        let rateCount;
        try {
            rateCount = await withTransaction(async tx => {
            if (rates !== undefined) {
                await tx.run('DELETE FROM party_product_rates WHERE party_id = ?', [party.id]);
                for (const r of rates) {
                    await tx.run('INSERT INTO party_product_rates (party_id, product_id, rate) VALUES (?, ?, ?)', [
                        party.id, r.product_id, r.rate,
                    ]);
                }
            }
            const row = await tx.queryOne('SELECT COUNT(*) AS n FROM party_product_rates WHERE party_id = ?', [party.id]);

            // Saving never blocks on what's missing — it only decides whether the form counts as
            // "complete" (which is what unlocks ordering for this party).
            const missing = [];
            if (!next.owner_image) missing.push('Owner Photo');
            if (!next.aadhar_no) missing.push('Aadhar Number');
            if (!next.aadhar_image) missing.push('Aadhar Photo');
            if (!next.pan_no) missing.push('PAN Number');
            if (!next.pan_image) missing.push('PAN Photo');
            if (!next.comment) missing.push('Comment');
            if (row.n === 0) missing.push('Product Rate');

            await tx.run(
                `UPDATE parties SET aadhar_no = ?, pan_no = ?, gst_no = ?, form_no = ?, comment = ?,
                        owner_image = ?, aadhar_image = ?, pan_image = ?, fill_form_completed = ? WHERE id = ?`,
                [next.aadhar_no, next.pan_no, next.gst_no, next.form_no, next.comment,
                 next.owner_image, next.aadhar_image, next.pan_image, missing.length === 0 ? 1 : 0, party.id]
            );
            return { n: row.n, missing };
            });
        } catch (e) {
            await deleteFromCloudinary(Object.values(images)); // don't leave orphaned uploads behind
            if (e.code === '23503') {
                return sendJson(res, false, 'One of the products no longer exists — reload the form and try again.', {}, 422);
            }
            throw e;
        }

        // Replaced photos are removed from Cloudinary.
        await deleteFromCloudinary(
            ['owner_image', 'aadhar_image', 'pan_image'].filter(f => images[f] && party[f]).map(f => party[f])
        );

        const completed = rateCount.missing.length === 0;
        sendJson(res, true, completed ? 'Fill Form saved.' : 'Saved — still missing: ' + rateCount.missing.join(', '), {
            fill_form_completed: completed,
        });
    })
);

// POST /api/parties/:id/delete — Admin/Manager (also used to reject a Pending party)
router.post(
    '/:id/delete',
    requireRole('Admin', 'Manager'),
    asyncHandler(async (req, res) => {
        const party = await queryOne('SELECT * FROM parties WHERE id = ?', [req.params.id]);
        if (!party) return sendJson(res, false, 'Party not found.', {}, 404);

        try {
            await run('DELETE FROM parties WHERE id = ?', [party.id]);
        } catch (e) {
            if (e.code === '23503') {
                return sendJson(res, false, 'This party has orders. Delete its orders first (Admin → Overview / All Orders), then delete the party.', {}, 409);
            }
            throw e;
        }
        await deleteFromCloudinary([party.shop_image, party.owner_image, party.aadhar_image, party.pan_image]);
        sendJson(res, true, 'Party deleted.');
    })
);

/** Downloads an image from Cloudinary as a JPEG buffer for the PDF (null if it can't be fetched). */
async function fetchImageBuffer(url) {
    if (!url) return null;
    try {
        // Ask Cloudinary for a PDF-friendly JPEG at a sensible size.
        const jpgUrl = url.includes('/upload/') ? url.replace('/upload/', '/upload/f_jpg,q_auto,w_900/') : url;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        const r = await fetch(jpgUrl, { signal: controller.signal });
        clearTimeout(timer);
        if (!r.ok) return null;
        return Buffer.from(await r.arrayBuffer());
    } catch {
        return null;
    }
}

// GET /api/parties/:id/pdf — "Party Details" PDF: party info, shop/owner photos, and Aadhar/PAN photos.
router.get(
    '/:id/pdf',
    asyncHandler(async (req, res) => {
        const party = await queryOne('SELECT * FROM parties WHERE id = ?', [req.params.id]);
        if (!party) return sendJson(res, false, 'Party not found.', {}, 404);

        // Fetch every photo BEFORE we start streaming the PDF.
        const [shopImg, ownerImg, aadharImg, panImg] = await Promise.all([
            fetchImageBuffer(party.shop_image),
            fetchImageBuffer(party.owner_image),
            fetchImageBuffer(party.aadhar_image),
            fetchImageBuffer(party.pan_image),
        ]);

        const companyName = process.env.COMPANY_NAME || 'NXCO';
        const safeName = (party.party_name || 'party').replace(/[^a-z0-9]+/gi, '_');

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}_details.pdf"`);

        const doc = new PDFDocument({ size: 'A4', margin: 40 });
        doc.pipe(res);

        const pageBottom = () => doc.page.height - doc.page.margins.bottom;
        const ensureSpace = needed => { if (doc.y + needed > pageBottom()) doc.addPage(); };

        function row(label, value) {
            doc.font('Helvetica-Bold').fontSize(10).text(`${label}: `, { continued: true });
            doc.font('Helvetica').text(value || '-');
        }

        // One labeled photo box; shows a placeholder note when the photo was never uploaded or can't be fetched.
        function addPhoto(label, buffer, x, boxTop, w, h) {
            doc.font('Helvetica-Bold').fontSize(9).text(label, x, boxTop);
            const imgTop = boxTop + 13;
            if (buffer) {
                try {
                    doc.image(buffer, x, imgTop, { fit: [w, h] });
                    return;
                } catch { /* fall through to the note below */ }
            }
            doc.font('Helvetica').fontSize(8).fillColor('#999').text('Not uploaded.', x, imgTop);
            doc.fillColor('#000');
        }

        doc.fontSize(18).font('Helvetica-Bold').text(companyName);
        doc.fontSize(10).font('Helvetica').fillColor('#555').text('Party Details Report');
        doc.fillColor('#000');
        doc.moveDown(0.8);

        doc.fontSize(16).font('Helvetica-Bold').text(party.party_name);
        doc.fontSize(9).font('Helvetica').fillColor('#888').text(`Status: ${party.status}`);
        doc.fillColor('#000');
        doc.moveDown(0.6);

        row('Owner Name', party.owner_name);
        row('Mobile', party.mobile);
        row('Water Brand', party.water_brand);
        row('Area / City', `${party.area || '-'}, ${party.city || '-'}`);
        row('Address', party.address);
        row('Vehicle Access', (party.vehicle_types || '').split(',').filter(Boolean).join(', '));
        row('Years of Experience', String(party.years_exp || 0));
        doc.moveDown(0.6);

        doc.font('Helvetica-Bold').fontSize(11).text('Fill Form / KYC Details');
        doc.moveDown(0.2);
        row('Aadhar Number', party.aadhar_no);
        row('PAN Number', party.pan_no);
        row('GST Number', party.gst_no);
        row('Comment', party.comment);
        doc.moveDown(1);

        const colW = 240;
        const rowH = 150;
        const gap = 20;

        ensureSpace(rowH + 30);
        doc.font('Helvetica-Bold').fontSize(11).text('Dashboard Photos');
        doc.moveDown(0.3);
        let y = doc.y;
        addPhoto('Shop Photo', shopImg, 40, y, colW, rowH);
        addPhoto('Owner Photo', ownerImg, 40 + colW + gap, y, colW, rowH);
        doc.y = y + rowH + 24;

        ensureSpace(rowH + 30);
        doc.font('Helvetica-Bold').fontSize(11).text('Fill Form Documents', 40, doc.y);
        doc.moveDown(0.3);
        y = doc.y;
        addPhoto('Aadhar Photo', aadharImg, 40, y, colW, rowH);
        addPhoto('PAN Photo', panImg, 40 + colW + gap, y, colW, rowH);
        doc.y = y + rowH + 24;

        doc.moveDown(1);
        doc.font('Helvetica').fontSize(8).fillColor('#888').text(`Generated on ${new Date().toLocaleString('en-IN')}`, 40);

        doc.end();
    })
);

module.exports = router;
