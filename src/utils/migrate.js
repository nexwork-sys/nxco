/** `npm run migrate` — creates every table (idempotent). Also runs automatically when the server boots. */
require('dotenv').config();
const { connectDB, initSchema, getPool } = require('../config/db');

(async () => {
    try {
        await connectDB();
        await initSchema();
        await getPool().end();
        process.exit(0);
    } catch (err) {
        console.error('[migrate] Failed:', err.message);
        process.exit(1);
    }
})();
