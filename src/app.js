const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth.routes');
const employeesRoutes = require('./routes/employees.routes');
const partiesRoutes = require('./routes/parties.routes');
const productsRoutes = require('./routes/products.routes');
const ordersRoutes = require('./routes/orders.routes');
const attendanceRoutes = require('./routes/attendance.routes');
const trackingRoutes = require('./routes/tracking.routes');
const settingsRoutes = require('./routes/settings.routes');
const visitsRoutes = require('./routes/visits.routes');
const pjpRoutes = require('./routes/pjp.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const targetsRoutes = require('./routes/targets.routes');
const paymentsRoutes = require('./routes/payments.routes');

const app = express();

const allowedOrigins = (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim());
app.use(cors({ origin: allowedOrigins.includes('*') ? true : allowedOrigins }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Images are stored on Cloudinary — the API returns full https URLs, nothing is served from this server's disk.

app.get('/api/health', (req, res) => res.json({ success: true, message: 'NXCO API is running.' }));

app.use('/api/auth', authRoutes);
app.use('/api/employees', employeesRoutes);
app.use('/api/parties', partiesRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/tracking', trackingRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/visits', visitsRoutes);
app.use('/api/pjp', pjpRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/targets', targetsRoutes);
app.use('/api/payments', paymentsRoutes);

// 404 for unmatched API routes
app.use('/api', (req, res) => res.status(404).json({ success: false, message: 'Not found.' }));

// Central error handler — catches everything asyncHandler forwards, plus
// Multer/validation errors, and always returns the same JSON shape.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error(err);
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : err.name === 'MulterError' ? 400 : 500);
    res.status(status).json({ success: false, message: err.message || 'Something went wrong.' });
});

module.exports = app;
