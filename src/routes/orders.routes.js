const express = require('express');
const PDFDocument = require('pdfkit');
const { query, queryOne, withTransaction } = require('../config/db');
const { requireLogin, requireRole, sendJson } = require('../middleware/auth');
const { makeUploader, uploadToCloudinary, uploadManyToCloudinary, deleteFromCloudinary } = require('../middleware/upload');
const asyncHandler = require('../utils/asyncHandler');
const { ORDER_STATUSES, PAYMENT_MODES, PAYMENT_METHODS } = require('../models/constants');

const router = express.Router();

// documents[] (up to 5) + one cheque_image (only used for Credit orders) — all pushed to Cloudinary.
const upload = makeUploader(['.jpg', '.jpeg', '.png', '.pdf']).fields([
    { name: 'documents', maxCount: 5 },
    { name: 'cheque_image', maxCount: 1 },
]);

// Which roles may move an order into which status.
const STATUS_PERMISSIONS = {
    Confirmed: ['Admin', 'Supervisor', 'Manager', 'Operator'],
    'Ready to Dispatch': ['Admin', 'Supervisor', 'Manager', 'Operator'],
    'On the Way': ['Admin', 'Driver'],
    Completed: ['Admin', 'Driver'],
    Cancelled: ['Admin', 'Supervisor', 'Manager'],
};

// While an order is in one of these statuses its stock is still "ours" — deleting the order puts it back.
// Completed orders were delivered (stock is gone for good) and Cancelled ones were already restocked.
const STOCK_HELD_STATUSES = ['Pending', 'Confirmed', 'Ready to Dispatch', 'On the Way'];

router.use(requireLogin);

const httpError = (message, status) => Object.assign(new Error(message), { status });

/** Validate & normalize the items array a client sends: [{product_id, quantity}]. */
function parseItems(raw) {
    let items;
    try {
        items = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
        return null;
    }
    if (!Array.isArray(items) || items.length === 0) return null;
    for (const it of items) {
        if (!it.product_id || !Number.isFinite(Number(it.quantity)) || Number(it.quantity) <= 0) return null;
    }
    return items.map(it => ({ product_id: Number(it.product_id), quantity: Math.floor(Number(it.quantity)) }));
}

/**
 * Payment details chosen on the order: Cash, or Credit (goods now, money later against a cheque —
 * cheque number + photo required). Returns { error } or { mode, chequeNo }.
 */
function parsePayment(body, { existingMode, existingChequeNo, hasChequeImage }) {
    const mode = body.payment_mode !== undefined ? body.payment_mode : existingMode || 'Cash';
    if (!PAYMENT_MODES.includes(mode)) return { error: 'Payment must be Cash or Credit.' };
    if (mode === 'Cash') return { mode, chequeNo: '' };

    const chequeNo = String(body.cheque_no !== undefined ? body.cheque_no : existingChequeNo || '').trim();
    if (!chequeNo) return { error: 'Enter the cheque number for a Credit order.' };
    if (!hasChequeImage) return { error: 'Add the cheque photo for a Credit order.' };
    return { mode, chequeNo };
}

/** Rate for each item = this party's negotiated rate (Fill Form). Throws a friendly error if a product has no rate yet. */
async function attachPartyRates(tx, items, party) {
    const rows = await tx.query('SELECT product_id, rate FROM party_product_rates WHERE party_id = ?', [party.id]);
    const rateByProduct = new Map(rows.map(r => [r.product_id, r.rate]));
    return items.map(it => {
        const rate = rateByProduct.get(it.product_id);
        if (rate === undefined) {
            throw httpError(`No rate set for this product for "${party.party_name}" yet — complete the Fill Form first.`, 422);
        }
        return { ...it, rate };
    });
}

/** Deduct stock for each item (row-locked), throwing a friendly error if any product is short. */
async function deductStock(tx, items) {
    // Lock products in a stable order so two simultaneous orders can't deadlock each other.
    for (const { product_id, quantity } of [...items].sort((a, b) => a.product_id - b.product_id)) {
        const product = await tx.queryOne('SELECT * FROM products WHERE id = ? FOR UPDATE', [product_id]);
        if (!product) throw httpError('One of the selected products no longer exists.', 404);
        if (product.quantity < quantity) {
            throw httpError(`Not enough stock for "${product.product_name}". Available: ${product.quantity}, Ordered: ${quantity}.`, 422);
        }
        await tx.run('UPDATE products SET quantity = quantity - ? WHERE id = ?', [quantity, product_id]);
    }
}

async function restock(tx, items) {
    for (const { product_id, quantity } of items) {
        if (product_id == null) continue; // product was deleted from inventory since
        await tx.run('UPDATE products SET quantity = quantity + ? WHERE id = ?', [quantity, product_id]);
    }
}

/** Deep-compare two order item arrays regardless of order, for the duplicate-submit guard. */
function itemsMatch(a, b) {
    if (a.length !== b.length) return false;
    const norm = arr => arr.map(it => `${it.product_id}:${it.quantity}`).sort().join('|');
    return norm(a) === norm(b);
}

/** Loads orders (+ party, creator, items, documents) matching a WHERE clause, newest first, in 3 queries total. */
async function loadOrders(where = '', params = []) {
    const orders = await query(
        `SELECT o.*, p.party_name, p.area, p.city, p.address AS party_address, p.mobile AS party_mobile,
                p.lat AS party_lat, p.lng AS party_lng, p.gst_no AS party_gst_no, u.name AS created_by_name, u.employee_id AS created_by_emp_id
           FROM orders o
           LEFT JOIN parties p ON p.id = o.party_id
           LEFT JOIN users u ON u.id = o.created_by
           ${where}
          ORDER BY o.created_at DESC, o.id DESC`,
        params
    );
    if (orders.length === 0) return [];

    const ids = orders.map(o => o.id);
    const [items, docs] = await Promise.all([
        query(
            `SELECT oi.order_id, oi.product_id, oi.quantity, oi.rate, pr.brand_name, pr.product_name
               FROM order_items oi LEFT JOIN products pr ON pr.id = oi.product_id
              WHERE oi.order_id IN (?) ORDER BY oi.id ASC`,
            [ids]
        ),
        query('SELECT order_id, url FROM order_documents WHERE order_id IN (?) ORDER BY id ASC', [ids]),
    ]);

    return orders.map(o => serializeOrder(o, items.filter(i => i.order_id === o.id), docs.filter(d => d.order_id === o.id)));
}

function serializeOrder(o, itemRows, docRows) {
    const items = itemRows.map(it => ({
        product_id: it.product_id,
        product_name: it.product_name,
        brand_name: it.brand_name,
        quantity: it.quantity,
        rate: it.rate,
        amount: it.rate * it.quantity,
    }));
    return {
        id: o.id,
        party: {
            id: o.party_id,
            party_name: o.party_name,
            area: o.area,
            city: o.city,
            address: o.party_address,
            mobile: o.party_mobile,
            lat: o.party_lat,
            lng: o.party_lng,
        },
        created_by_name: o.created_by_name,
        items,
        total: items.reduce((sum, it) => sum + it.amount, 0),
        comment: o.comment || '',
        gst_no: o.gst_no,
        status: o.status,
        // Chosen when the order was placed:
        payment_mode: o.payment_mode,
        cheque_no: o.cheque_no,
        cheque_image: o.cheque_image,
        // Filled in when the driver/admin completes the delivery:
        payment_collected: o.payment_collected === null ? null : !!o.payment_collected,
        amount_collected: o.amount_collected,
        payment_method: o.payment_method,
        documents: docRows.map(d => d.url),
        created_at: o.created_at,
        // used only by the invoice
        _party_gst_no: o.party_gst_no,
        _created_by_emp_id: o.created_by_emp_id,
    };
}

/** Strips the invoice-only helper fields before sending an order to the client. */
const publicOrder = ({ _party_gst_no, _created_by_emp_id, ...rest }) => rest;

// GET /api/orders?status=Pending — role-scoped visibility, newest first
router.get(
    '/',
    asyncHandler(async (req, res) => {
        const where = [];
        const params = [];
        if (req.user.role === 'Marketing') {
            where.push('o.created_by = ?');
            params.push(req.user.id);
        } else if (req.user.role === 'Driver') {
            where.push("o.status IN ('Ready to Dispatch', 'On the Way', 'Completed')");
        }
        if (req.query.status) {
            // an explicit ?status= replaces the Driver's default filter, same as before
            if (req.user.role === 'Driver') where.pop();
            where.push('o.status = ?');
            params.push(req.query.status);
        }
        const orders = await loadOrders(where.length ? 'WHERE ' + where.join(' AND ') : '', params);
        sendJson(res, true, '', { orders: orders.map(publicOrder) });
    })
);

// GET /api/orders/:id
router.get(
    '/:id',
    asyncHandler(async (req, res) => {
        const [order] = await loadOrders('WHERE o.id = ?', [req.params.id]);
        if (!order) return sendJson(res, false, 'Order not found.', {}, 404);
        sendJson(res, true, '', { order: publicOrder(order) });
    })
);

// GET /api/orders/:id/invoice — downloadable PDF invoice. Admin can pull any order; Marketing only their own.
router.get(
    '/:id/invoice',
    asyncHandler(async (req, res) => {
        const [o] = await loadOrders('WHERE o.id = ?', [req.params.id]);
        if (!o) return sendJson(res, false, 'Order not found.', {}, 404);
        const owner = await queryOne('SELECT created_by FROM orders WHERE id = ?', [o.id]);
        if (req.user.role === 'Marketing' && owner.created_by !== req.user.id) {
            return sendJson(res, false, 'You can only download invoices for your own orders.', {}, 403);
        }

        const companyName = process.env.COMPANY_NAME || 'NXCO';
        const invoiceNo = `INV-${String(o.id).padStart(6, '0')}`;

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${invoiceNo}.pdf"`);

        const doc = new PDFDocument({ size: 'A4', margin: 40 });
        doc.pipe(res);

        // Header
        doc.fontSize(18).font('Helvetica-Bold').text(companyName, { align: 'left' });
        doc.fontSize(10).font('Helvetica').fillColor('#555').text('Order Invoice', { align: 'left' });
        doc.moveDown(0.5);
        doc.fillColor('#000');

        const headerTop = doc.y;
        doc.fontSize(10).font('Helvetica-Bold').text('Invoice No: ', 40, headerTop, { continued: true }).font('Helvetica').text(invoiceNo);
        doc.font('Helvetica-Bold').text('Order Date: ', { continued: true }).font('Helvetica').text(new Date(o.created_at).toLocaleString('en-IN'));
        doc.font('Helvetica-Bold').text('Status: ', { continued: true }).font('Helvetica').text(o.status);
        doc.font('Helvetica-Bold').text('Placed By: ', { continued: true }).font('Helvetica').text(o.created_by_name || '-');
        doc.font('Helvetica-Bold').text('Payment: ', { continued: true }).font('Helvetica').text(
            o.payment_mode === 'Credit' ? `Credit (pay later) - Cheque No: ${o.cheque_no || '-'}` : 'Cash'
        );
        doc.moveDown(0.8);

        // Party (Bill To)
        doc.font('Helvetica-Bold').fontSize(11).text('Bill To / Party Details');
        doc.moveTo(40, doc.y + 2).lineTo(555, doc.y + 2).strokeColor('#ccc').stroke();
        doc.moveDown(0.4);
        const party = o.party;
        doc.font('Helvetica-Bold').fontSize(10).text(party?.party_name || '-');
        doc.font('Helvetica').fontSize(9.5).fillColor('#333');
        if (party?.address) doc.text(party.address);
        const locLine = [party?.area, party?.city].filter(Boolean).join(', ');
        if (locLine) doc.text(locLine);
        if (party?.mobile) doc.text(`Mobile: ${party.mobile}`);
        if (o.gst_no || o._party_gst_no) doc.text(`GSTIN: ${o.gst_no || o._party_gst_no}`);
        doc.fillColor('#000');
        doc.moveDown(1);

        // Items table
        const tableTop = doc.y;
        const cols = { sr: 40, name: 75, qty: 340, rate: 400, amount: 470 };
        doc.font('Helvetica-Bold').fontSize(9.5);
        doc.text('Sr', cols.sr, tableTop);
        doc.text('Product', cols.name, tableTop);
        doc.text('Qty', cols.qty, tableTop, { width: 50, align: 'right' });
        doc.text('Rate', cols.rate, tableTop, { width: 60, align: 'right' });
        doc.text('Amount', cols.amount, tableTop, { width: 85, align: 'right' });
        doc.moveTo(40, tableTop + 14).lineTo(555, tableTop + 14).strokeColor('#000').stroke();

        let y = tableTop + 20;
        doc.font('Helvetica').fontSize(9.5);
        o.items.forEach((it, idx) => {
            const label = [it.brand_name, it.product_name].filter(Boolean).join(' - ') || 'Product';
            doc.text(String(idx + 1), cols.sr, y);
            doc.text(label, cols.name, y, { width: 260 });
            doc.text(String(it.quantity), cols.qty, y, { width: 50, align: 'right' });
            doc.text(it.rate.toFixed(2), cols.rate, y, { width: 60, align: 'right' });
            doc.text(it.amount.toFixed(2), cols.amount, y, { width: 85, align: 'right' });
            y += 18;
        });
        doc.moveTo(40, y + 2).lineTo(555, y + 2).strokeColor('#ccc').stroke();
        y += 12;
        doc.font('Helvetica-Bold').fontSize(11).text('Total', cols.rate, y, { width: 60, align: 'right' });
        doc.text(`Rs. ${o.total.toFixed(2)}`, cols.amount, y, { width: 85, align: 'right' });

        if (o.comment) {
            doc.moveDown(2);
            doc.font('Helvetica-Bold').fontSize(9.5).text('Comment:', 40);
            doc.font('Helvetica').text(o.comment, 40, doc.y, { width: 500 });
        }

        doc.moveDown(2);
        doc.font('Helvetica').fontSize(8).fillColor('#888').text(`Generated on ${new Date().toLocaleString('en-IN')}`, 40);

        doc.end();
    })
);

// POST /api/orders — Marketing/Admin places a new order (multipart).
//   party_id, products_json, comment, gst_no, documents[] (optional photos),
//   payment_mode ('Cash' | 'Credit'; default Cash),
//   cheque_no + cheque_image  — required when payment_mode is 'Credit'.
router.post(
    '/',
    requireRole('Marketing', 'Admin'),
    upload,
    asyncHandler(async (req, res) => {
        const { party_id, comment, gst_no } = req.body || {};
        const items = parseItems(req.body?.products_json ?? req.body?.items);
        if (!party_id || !items) {
            return sendJson(res, false, 'Select a party and at least one product with a valid quantity.', {}, 422);
        }
        const party = await queryOne('SELECT * FROM parties WHERE id = ?', [party_id]);
        if (!party) return sendJson(res, false, 'Party not found.', {}, 404);

        const chequeFile = req.files?.cheque_image?.[0];
        const payment = parsePayment(req.body || {}, { hasChequeImage: !!chequeFile });
        if (payment.error) return sendJson(res, false, payment.error, {}, 422);

        // Server-side duplicate-submission guard: the same user placing an identical order (same party +
        // same items) within 10 seconds is a double-tap/retry, not a new order.
        const recent = await queryOne(
            `SELECT id FROM orders
              WHERE created_by = ? AND party_id = ? AND COALESCE(comment, '') = ?
                AND created_at >= (UTC_TIMESTAMP() - INTERVAL 10 SECOND)
              ORDER BY id DESC LIMIT 1`,
            [req.user.id, party.id, comment || '']
        );
        if (recent) {
            const recentItems = await query('SELECT product_id, quantity FROM order_items WHERE order_id = ?', [recent.id]);
            if (itemsMatch(recentItems, items)) {
                return sendJson(res, true, 'Order placed.', { id: recent.id, deduped: true });
            }
        }

        // Images go to Cloudinary first (outside the DB transaction so we never hold row locks during an upload).
        const [documentUrls, chequeUrl] = await Promise.all([
            uploadManyToCloudinary(req.files?.documents, 'documents'),
            payment.mode === 'Credit' ? uploadToCloudinary(chequeFile, 'cheques') : null,
        ]);
        const uploaded = [...documentUrls, chequeUrl].filter(Boolean);

        try {
            const orderId = await withTransaction(async tx => {
                const ratedItems = await attachPartyRates(tx, items, party);
                await deductStock(tx, ratedItems);

                const result = await tx.run(
                    `INSERT INTO orders (party_id, created_by, comment, gst_no, payment_mode, cheque_no, cheque_image)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [party.id, req.user.id, comment || '', gst_no || '', payment.mode, payment.chequeNo, chequeUrl || null]
                );
                for (const it of ratedItems) {
                    await tx.run('INSERT INTO order_items (order_id, product_id, quantity, rate) VALUES (?, ?, ?, ?)', [
                        result.insertId, it.product_id, it.quantity, it.rate,
                    ]);
                }
                for (const url of documentUrls) {
                    await tx.run('INSERT INTO order_documents (order_id, url) VALUES (?, ?)', [result.insertId, url]);
                }
                return result.insertId;
            });
            sendJson(res, true, 'Order placed.', { id: orderId });
        } catch (e) {
            await deleteFromCloudinary(uploaded); // order failed (e.g. out of stock) — don't keep its photos
            sendJson(res, false, e.message || 'Could not place order.', {}, e.status || 500);
        }
    })
);

// POST /api/orders/:id/update — only while Pending, and only by whoever placed it or Admin.
// Can change items, comment, GST, and the payment choice (Cash/Credit + cheque number/photo).
router.post(
    '/:id/update',
    requireRole('Marketing', 'Admin'),
    upload,
    asyncHandler(async (req, res) => {
        const order = await queryOne('SELECT * FROM orders WHERE id = ?', [req.params.id]);
        if (!order) return sendJson(res, false, 'Order not found.', {}, 404);
        if (order.status !== 'Pending') {
            return sendJson(res, false, 'Only Pending orders can be edited.', {}, 409);
        }
        if (req.user.role === 'Marketing' && order.created_by !== req.user.id) {
            return sendJson(res, false, 'You can only edit your own orders.', {}, 403);
        }

        const body = req.body || {};
        const newItems = parseItems(body.products_json ?? body.items);
        const chequeFile = req.files?.cheque_image?.[0];

        const payment = parsePayment(body, {
            existingMode: order.payment_mode,
            existingChequeNo: order.cheque_no,
            hasChequeImage: !!chequeFile || !!order.cheque_image,
        });
        if (payment.error) return sendJson(res, false, payment.error, {}, 422);

        const newChequeUrl = payment.mode === 'Credit' && chequeFile ? await uploadToCloudinary(chequeFile, 'cheques') : null;
        // Cash orders carry no cheque; Credit keeps the old photo unless a new one was sent.
        const finalChequeImage = payment.mode === 'Cash' ? null : newChequeUrl || order.cheque_image;

        try {
            await withTransaction(async tx => {
                const locked = await tx.queryOne('SELECT status FROM orders WHERE id = ? FOR UPDATE', [order.id]);
                if (!locked || locked.status !== 'Pending') throw httpError('Only Pending orders can be edited.', 409);

                if (newItems) {
                    const party = await tx.queryOne('SELECT * FROM parties WHERE id = ?', [order.party_id]);
                    if (!party) throw httpError('Party not found.', 404);
                    const ratedItems = await attachPartyRates(tx, newItems, party);
                    // Return old stock, then deduct the new quantities — keeps stock accurate
                    // even if the product list itself changed.
                    const oldItems = await tx.query('SELECT product_id, quantity FROM order_items WHERE order_id = ?', [order.id]);
                    await restock(tx, oldItems);
                    await deductStock(tx, ratedItems);
                    await tx.run('DELETE FROM order_items WHERE order_id = ?', [order.id]);
                    for (const it of ratedItems) {
                        await tx.run('INSERT INTO order_items (order_id, product_id, quantity, rate) VALUES (?, ?, ?, ?)', [
                            order.id, it.product_id, it.quantity, it.rate,
                        ]);
                    }
                }
                await tx.run(
                    'UPDATE orders SET comment = ?, gst_no = ?, payment_mode = ?, cheque_no = ?, cheque_image = ? WHERE id = ?',
                    [
                        body.comment !== undefined ? body.comment : order.comment || '',
                        body.gst_no !== undefined ? body.gst_no : order.gst_no,
                        payment.mode,
                        payment.chequeNo,
                        finalChequeImage,
                        order.id,
                    ]
                );
            });
            // Old cheque photo is no longer used (replaced, or the order switched to Cash).
            if (order.cheque_image && order.cheque_image !== finalChequeImage) await deleteFromCloudinary(order.cheque_image);
            sendJson(res, true, 'Order updated.');
        } catch (e) {
            await deleteFromCloudinary(newChequeUrl);
            sendJson(res, false, e.message || 'Could not update order.', {}, e.status || 500);
        }
    })
);

// POST /api/orders/:id/delete
//   Admin     — can delete an order in ANY status (Overview / All Orders screens).
//   Marketing — only their own order, and only while it is still Pending.
// Deleting removes the order completely: its items, documents, cheque photo (also from Cloudinary) and every
// payment entry recorded against it, so the party's billed / due figures and the employee's target progress
// no longer count it. Stock goes back to inventory unless the order was already delivered (Completed) or
// Cancelled (restocked at cancel time).
router.post(
    '/:id/delete',
    requireRole('Marketing', 'Admin'),
    asyncHandler(async (req, res) => {
        const order = await queryOne('SELECT * FROM orders WHERE id = ?', [req.params.id]);
        if (!order) return sendJson(res, false, 'Order not found.', {}, 404);

        const isAdmin = req.user.role === 'Admin';
        if (!isAdmin) {
            if (order.created_by !== req.user.id) return sendJson(res, false, 'You can only delete your own orders.', {}, 403);
            if (order.status !== 'Pending') return sendJson(res, false, 'Only Pending orders can be deleted.', {}, 409);
        }

        try {
            const outcome = await withTransaction(async tx => {
                const locked = await tx.queryOne('SELECT status FROM orders WHERE id = ? FOR UPDATE', [order.id]);
                if (!locked) throw httpError('Order not found.', 404);
                if (!isAdmin && locked.status !== 'Pending') throw httpError('Only Pending orders can be deleted.', 409);

                const items = await tx.query('SELECT product_id, quantity FROM order_items WHERE order_id = ?', [order.id]);
                const stockReturned = STOCK_HELD_STATUSES.includes(locked.status);
                if (stockReturned) await restock(tx, items);

                const docs = await tx.query('SELECT url FROM order_documents WHERE order_id = ?', [order.id]);
                await tx.run('DELETE FROM payments WHERE order_id = ?', [order.id]);
                await tx.run('DELETE FROM orders WHERE id = ?', [order.id]); // items + documents cascade
                return { stockReturned, files: [...docs.map(d => d.url), order.cheque_image].filter(Boolean) };
            });
            await deleteFromCloudinary(outcome.files);
            sendJson(res, true, 'Order deleted.', { stock_returned: outcome.stockReturned });
        } catch (e) {
            sendJson(res, false, e.message || 'Could not delete order.', {}, e.status || 500);
        }
    })
);

// POST /api/orders/:id/status  { status, payment_collected?, amount_collected?, payment_method? }
// When a Driver/Admin marks an order Completed with payment_collected=true, amount_collected (Rupees) and
// payment_method ('Cash'|'Online') are required — this is what lets Admin/Marketing see exactly how much a
// driver took in the field, vs how much is still due from the party.
router.post(
    '/:id/status',
    asyncHandler(async (req, res) => {
        const newStatus = req.body?.status;
        if (!ORDER_STATUSES.includes(newStatus)) {
            return sendJson(res, false, 'Invalid status value.', {}, 422);
        }
        const allowedRoles = STATUS_PERMISSIONS[newStatus] || ['Admin'];
        if (!allowedRoles.includes(req.user.role)) {
            return sendJson(res, false, 'You are not permitted to set this status.', {}, 403);
        }

        const order = await queryOne('SELECT * FROM orders WHERE id = ?', [req.params.id]);
        if (!order) return sendJson(res, false, 'Order not found.', {}, 404);

        // Validate the payment fields up front so a bad request never touches stock/status at all.
        let paymentToRecord = null;
        const reportsPayment = newStatus === 'Completed' && req.body.payment_collected !== undefined;
        if (reportsPayment && req.body.payment_collected) {
            const amount = Number(req.body.amount_collected);
            const method = req.body.payment_method;
            if (!Number.isFinite(amount) || amount <= 0) {
                return sendJson(res, false, 'Enter how much was collected.', {}, 422);
            }
            if (!PAYMENT_METHODS.includes(method)) {
                return sendJson(res, false, 'Select Cash or Online.', {}, 422);
            }
            paymentToRecord = { amount, method };
        }

        await withTransaction(async tx => {
            const locked = await tx.queryOne('SELECT status FROM orders WHERE id = ? FOR UPDATE', [order.id]);
            if (!locked) throw httpError('Order not found.', 404);

            // Cancelling returns stock — but only once, so re-saving an already-Cancelled order doesn't double-restock.
            if (newStatus === 'Cancelled' && locked.status !== 'Cancelled') {
                const items = await tx.query('SELECT product_id, quantity FROM order_items WHERE order_id = ?', [order.id]);
                await restock(tx, items);
            }

            if (reportsPayment) {
                await tx.run(
                    'UPDATE orders SET status = ?, payment_collected = ?, amount_collected = ?, payment_method = ? WHERE id = ?',
                    [
                        newStatus,
                        req.body.payment_collected ? 1 : 0,
                        paymentToRecord ? paymentToRecord.amount : null,
                        paymentToRecord ? paymentToRecord.method : null,
                        order.id,
                    ]
                );
                // One Payment ledger entry per order — re-completing an already-Completed order (re-tap, or
                // correcting the amount) must not double it up, so clear any earlier entry first.
                await tx.run('DELETE FROM payments WHERE order_id = ?', [order.id]);
                if (paymentToRecord) {
                    await tx.run(
                        `INSERT INTO payments (party_id, order_id, amount, method, collected_by, note)
                         VALUES (?, ?, ?, ?, ?, 'Collected on delivery')`,
                        [order.party_id, order.id, paymentToRecord.amount, paymentToRecord.method, req.user.id]
                    );
                }
            } else {
                await tx.run('UPDATE orders SET status = ? WHERE id = ?', [newStatus, order.id]);
            }
        });
        sendJson(res, true, `Order status updated to "${newStatus}".`);
    })
);

module.exports = router;
