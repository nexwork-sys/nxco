const multer = require('multer');
const path = require('path');
const cloudinary = require('../config/cloudinary');

const ROOT_FOLDER = () => process.env.CLOUDINARY_FOLDER || 'nxco';

/**
 * Multer keeps uploads in memory (no files are ever written to this server's
 * disk — Render/Heroku-style hosts wipe disk on every deploy anyway). The
 * route then pushes each file to Cloudinary with uploadToCloudinary() and
 * stores the returned https URL in PostgreSQL.
 */
function makeUploader(allowedExt = ['.jpg', '.jpeg', '.png', '.pdf']) {
    return multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 5 * 1024 * 1024 }, // 5MB cap
        fileFilter: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            cb(null, allowedExt.includes(ext));
        },
    });
}

/** Uploads one multer file (memory buffer) to Cloudinary under `<root>/<folder>` and returns its secure URL. */
function uploadToCloudinary(file, folder) {
    return new Promise((resolve, reject) => {
        if (!file?.buffer) return resolve(null);
        const stream = cloudinary.uploader.upload_stream(
            { folder: `${ROOT_FOLDER()}/${folder}`, resource_type: 'auto' },
            (err, result) => (err ? reject(err) : resolve(result.secure_url))
        );
        stream.end(file.buffer);
    });
}

/** Uploads several multer files in parallel; resolves to an array of URLs (same order). */
function uploadManyToCloudinary(files, folder) {
    return Promise.all((files || []).map(f => uploadToCloudinary(f, folder)));
}

/** Pulls the Cloudinary public_id + resource type out of a delivery URL we stored earlier. */
function parseCloudinaryUrl(url) {
    const m = /\/(image|video|raw)\/upload\/(?:[^/]+\/)*?(?:v\d+\/)?(.+?)(?:\.[a-z0-9]+)?$/i.exec(url || '');
    return m ? { resource_type: m[1], public_id: decodeURIComponent(m[2]) } : null;
}

/** Best-effort delete of previously uploaded files by URL. Never throws — a leftover image must not break an API call. */
async function deleteFromCloudinary(urls) {
    const list = (Array.isArray(urls) ? urls : [urls]).filter(u => typeof u === 'string' && u.includes('res.cloudinary.com'));
    await Promise.all(
        list.map(async url => {
            const parsed = parseCloudinaryUrl(url);
            if (!parsed) return;
            try {
                await cloudinary.uploader.destroy(parsed.public_id, { resource_type: parsed.resource_type });
            } catch (e) {
                console.warn('[cloudinary] could not delete', url, e.message);
            }
        })
    );
}

module.exports = { makeUploader, uploadToCloudinary, uploadManyToCloudinary, deleteFromCloudinary };
