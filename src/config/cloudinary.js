const { v2: cloudinary } = require('cloudinary');

// Works with either CLOUDINARY_URL (the SDK reads it automatically) or the
// three separate CLOUDINARY_* variables.
if (!process.env.CLOUDINARY_URL) {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
    });
}
cloudinary.config({ secure: true });

module.exports = cloudinary;
