const jwt = require('jsonwebtoken');
const { queryOne } = require('../config/db');

/**
 * Standard JSON envelope used by every endpoint:
 *   { success, message, ...extraFields }
 */
function sendJson(res, success, message = '', extra = {}, status = null) {
    res.status(status ?? (success ? 200 : 400)).json({ success, message, ...extra });
}

/** Requires a valid Bearer JWT; attaches the user row to req.user (req.user.id is the DB id). */
function requireLogin(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return sendJson(res, false, 'Not authenticated.', {}, 401);

    jwt.verify(token, process.env.JWT_SECRET, async (err, payload) => {
        if (err) return sendJson(res, false, 'Session expired. Please log in again.', {}, 401);
        try {
            const user = await queryOne('SELECT * FROM users WHERE id = ?', [payload.id]);
            if (!user || !user.active) return sendJson(res, false, 'Account not found or disabled.', {}, 401);
            req.user = user;
            next();
        } catch (e) {
            next(e);
        }
    });
}

/** Call after requireLogin — 403s if the user's role isn't in the allow-list. */
function requireRole(...roles) {
    const allowed = roles.flat();
    return (req, res, next) => {
        if (!req.user) return sendJson(res, false, 'Not authenticated.', {}, 401);
        if (!allowed.includes(req.user.role)) {
            return sendJson(res, false, 'You do not have permission to perform this action.', {}, 403);
        }
        next();
    };
}

module.exports = { requireLogin, requireRole, sendJson };
