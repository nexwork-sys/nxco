const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// Return numbers (not strings) for BIGINT (COUNT/SUM) and NUMERIC (money) so the API's JSON shapes stay the same.
types.setTypeParser(20, v => Number(v));      // int8
types.setTypeParser(1700, v => parseFloat(v)); // numeric

let pool = null;

function buildPoolConfig() {
    // Render ke internal URL par SSL ki zaroorat nahi hoti, external ke liye DB_SSL=true set kar sakte hain.
    // Agar URL mein render.com hai aur internal connection hai, toh SSL disable rakhein taaki auth/SSL error na aaye.
    const isRenderInternal = process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('oregon-postgres.render.com');
    const sslEnv = String(process.env.DB_SSL || '').toLowerCase() === 'true';
    
    const ssl = (sslEnv || !isRenderInternal && process.env.DATABASE_URL?.includes('oregon-postgres.render.com')) 
        ? { rejectUnauthorized: false } 
        : undefined;

    const base = { max: 10, ...(ssl ? { ssl } : {}) };

    if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL, ...base };
    if (!process.env.DB_NAME) {
        throw new Error('PostgreSQL is not configured. Set DATABASE_URL (or DB_HOST/DB_USER/DB_PASSWORD/DB_NAME) in .env.');
    }
    return {
        host: process.env.DB_HOST || '127.0.0.1',
        port: Number(process.env.DB_PORT) || 5432,
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME,
        ...base,
    };
}

/**
 * Translates the MySQL-style SQL the routes use into pg form:
 *   - `?` placeholders -> $1, $2, ...
 *   - `IN (?)` with an array param -> IN ($1, $2, ...)
 */
function translate(sql, params = []) {
    const out = [];
    let text = '';
    let i = 0;
    for (const ch of sql) {
        if (ch !== '?') { text += ch; continue; }
        const val = params[i++];
        if (Array.isArray(val)) {
            // Empty list can never match (same as MySQL's IN (NULL)).
            if (val.length === 0) { text += 'NULL'; continue; }
            text += val.map(v => { out.push(v); return `$${out.length}`; }).join(', ');
        } else {
            out.push(val);
            text += `$${out.length}`;
        }
    }
    return { text, values: out };
}

// Every table with a serial `id` — INSERTs into these get `RETURNING id` so callers can read `result.insertId`.
const NO_ID_TABLES = /^\s*INSERT\s+INTO\s+party_product_rates\b/i;
function withReturning(text) {
    if (/^\s*INSERT\b/i.test(text) && !/\bRETURNING\b/i.test(text) && !NO_ID_TABLES.test(text)) {
        return `${text.replace(/;\s*$/, '')} RETURNING id`;
    }
    return text;
}

async function exec(client, sql, params) {
    const { text, values } = translate(sql, params);
    return client.query(withReturning(text), values);
}

async function connectDB() {
    pool = new Pool(buildPoolConfig());
    // Keep session time in UTC so NOW() and the IST helpers in utils/dateIST.js agree on any server.
    pool.on('connect', client => client.query("SET TIME ZONE 'UTC'"));
    pool.on('error', err => console.error('[db] idle client error:', err.message));
    await pool.query('SELECT 1');
    console.log('[db] Connected to PostgreSQL');
    return pool;
}

function getPool() {
    if (!pool) throw new Error('Database not connected yet.');
    return pool;
}

/** Runs sql/schema.sql (all IF NOT EXISTS / OR REPLACE, so it's safe on every boot). */
async function initSchema() {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'sql', 'schema.sql'), 'utf8');
    await getPool().query(sql); // simple-query protocol: the whole file runs as one multi-statement script
    console.log('[db] Schema is up to date');
}

/** SELECT -> array of rows. */
async function query(sql, params = []) {
    return (await exec(getPool(), sql, params)).rows;
}

/** SELECT -> first row or null. */
async function queryOne(sql, params = []) {
    return (await query(sql, params))[0] || null;
}

/** INSERT/UPDATE/DELETE -> { insertId, affectedRows } (insertId is the new row's `id` for INSERTs). */
async function run(sql, params = []) {
    return toResult(await exec(getPool(), sql, params));
}

function toResult(r) {
    return { insertId: r.rows?.[0]?.id ?? 0, affectedRows: r.rowCount };
}

/**
 * Runs `fn(tx)` inside one transaction; commits on success, rolls back (and rethrows) on any error.
 * `tx` has the same query / queryOne / run helpers, bound to the transaction's connection.
 */
async function withTransaction(fn) {
    const client = await getPool().connect();
    const tx = {
        query: async (sql, params = []) => (await exec(client, sql, params)).rows,
        queryOne: async (sql, params = []) => (await exec(client, sql, params)).rows[0] || null,
        run: async (sql, params = []) => toResult(await exec(client, sql, params)),
    };
    try {
        await client.query('BEGIN');
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
        throw err;
    } finally {
        client.release();
    }
}

module.exports = { connectDB, initSchema, getPool, query, queryOne, run, withTransaction };