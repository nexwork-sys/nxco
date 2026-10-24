/**
 * `npm run seed` — creates the tables (if needed) and the default Admin login
 * (employee_id "admin" / password "admin123") if it doesn't exist yet.
 * Change the password right after first login.
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { connectDB, initSchema, queryOne, run, getPool } = require('../config/db');

(async () => {
    try {
        await connectDB();
        await initSchema();
        const exists = await queryOne('SELECT id FROM users WHERE employee_id = ?', ['admin']);
        if (exists) {
            console.log('[seed] Admin account already exists — nothing to do.');
        } else {
            await run(
                'INSERT INTO users (employee_id, name, mobile, designation, role, password_hash) VALUES (?, ?, ?, ?, ?, ?)',
                ['admin', 'Administrator', '0000000000', 'Admin', 'Admin', await bcrypt.hash('admin123', 10)]
            );
            console.log('[seed] Created default admin (employee_id: admin, password: admin123). Change this password after first login.');
        }
        await getPool().end();
        process.exit(0);
    } catch (err) {
        console.error('[seed] Failed:', err.message);
        process.exit(1);
    }
})();
