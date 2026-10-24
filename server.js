require('dotenv').config();
const { connectDB, initSchema } = require('./src/config/db');
const app = require('./src/app');

const PORT = process.env.PORT || 4000;

(async () => {
    try {
        await connectDB();
        await initSchema(); // creates any missing tables — safe to run on every boot
        app.listen(PORT, () => console.log(`[server] NXCO API listening on port ${PORT}`));
    } catch (err) {
        console.error('[server] Failed to start:', err.message);
        process.exit(1);
    }
})();
