const { query } = require('../config/db');

const VEHICLE_ICONS = { truck: '🚛', pickup: '🛻', magic: '🚐', auto: '🛺', toto: '🛺⚡' };

function userJson(u) {
    return {
        id: u.id,
        employee_id: u.employee_id,
        name: u.name,
        mobile: u.mobile,
        designation: u.designation,
        role: u.role,
        active: !!u.active,
    };
}

/** Turns a `parties` row (+ its rate rows) into the JSON shape the mobile app consumes. */
function partyJson(row, rates = []) {
    const vehicle_types = row.vehicle_types ? row.vehicle_types.split(',').filter(Boolean) : [];
    return {
        id: row.id,
        party_name: row.party_name,
        owner_name: row.owner_name,
        mobile: row.mobile,
        water_brand: row.water_brand,
        years_exp: row.years_exp,
        vehicle_types,
        truck_icon: vehicle_types.length ? vehicle_types.map(t => VEHICLE_ICONS[t] || '').join(' ') : '🚫',
        area: row.area,
        city: row.city,
        address: row.address || '',
        shop_image: row.shop_image,
        owner_image: row.owner_image,
        lat: row.lat,
        lng: row.lng,
        created_by: row.created_by,
        status: row.status,
        approved_by: row.approved_by,
        approved_at: row.approved_at,
        aadhar_no: row.aadhar_no,
        aadhar_image: row.aadhar_image,
        pan_no: row.pan_no,
        pan_image: row.pan_image,
        gst_no: row.gst_no,
        form_no: row.form_no,
        comment: row.comment || '',
        product_rates: rates,
        fill_form_completed: !!row.fill_form_completed,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/** Fetches the per-product rate rows for a list of party rows in ONE query and returns the finished JSON objects. */
async function attachRates(partyRows) {
    if (partyRows.length === 0) return [];
    const rateRows = await query('SELECT party_id, product_id, rate FROM party_product_rates WHERE party_id IN (?)', [
        partyRows.map(p => p.id),
    ]);
    const byParty = new Map();
    for (const r of rateRows) {
        if (!byParty.has(r.party_id)) byParty.set(r.party_id, []);
        byParty.get(r.party_id).push({ product_id: r.product_id, rate: r.rate });
    }
    return partyRows.map(p => partyJson(p, byParty.get(p.id) || []));
}

function productJson(p) {
    return {
        id: p.id,
        brand_name: p.brand_name,
        product_name: p.product_name,
        quantity: p.quantity,
        rate: p.rate,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
    };
}

module.exports = { userJson, partyJson, attachRates, productJson };
