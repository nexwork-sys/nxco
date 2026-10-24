# NXCO — Backend (Node.js + Express + PostgreSQL + Cloudinary)

## Setup

```bash
npm install
cp .env.example .env     # PostgreSQL + Cloudinary + JWT_SECRET
npm run seed             # creates tables + default admin (employee_id: admin / password: admin123)
npm run dev              # http://localhost:4000
```

Other scripts: `npm run migrate` (tables only), `npm start` (production).

### Environment (`.env`)
| Variable | Purpose |
|---|---|
| `DATABASE_URL` **or** `DB_HOST` `DB_PORT` `DB_USER` `DB_PASSWORD` `DB_NAME` | PostgreSQL connection |
| `DB_SSL=true` | needed for Render's *External* DB URL / most cloud hosts (not the Internal URL) |
| `CLOUDINARY_URL` **or** `CLOUDINARY_CLOUD_NAME` `CLOUDINARY_API_KEY` `CLOUDINARY_API_SECRET` | image storage |
| `CLOUDINARY_FOLDER` | root folder in your media library (default `nxco`) |
| `JWT_SECRET`, `JWT_EXPIRES_IN`, `PORT`, `COMPANY_NAME`, `CORS_ORIGINS` | app settings |

## Images
Multer keeps each upload in memory, the route sends it to Cloudinary, and the returned `https` URL is stored in PostgreSQL
(`shop_image`, `owner_image`, `aadhar_image`, `pan_image`, `orders.cheque_image`, `order_documents.url`, `company_settings.logo_path`).
Replaced / deleted records also delete their old image from Cloudinary. Nothing is written to this server's disk.
Folders: `shops/`, `kyc/`, `documents/`, `cheques/`, `branding/` (under `CLOUDINARY_FOLDER`).

## API changes in this version

| Endpoint | Change |
|---|---|
| `POST /api/parties/:id/fill-form` | no longer accepts/stores `payment_mode`, `cheque_no`, `cheque_image` |
| `POST /api/orders` (multipart) | new fields: `payment_mode` (`Cash`\|`Credit`, default `Cash`), `cheque_no`, `cheque_image` — the last two are **required** for `Credit` |
| `POST /api/orders/:id/update` | same payment fields; works while the order is Pending |
| `POST /api/orders/:id/delete` | **Admin: any status.** Marketing: own + Pending only. Returns `stock_returned` |
| Order JSON | now includes `payment_mode`, `cheque_no`, `cheque_image` |
| Invoice PDF | shows Cash, or Credit + cheque number |

Everything else (auth, employees, products, attendance, PJP, targets, payments, tracking, settings) keeps the same
URLs and response shapes as before, so the rest of the app is unchanged.

## Deploying on Render
1. **New → PostgreSQL** → create it, copy the **Internal Database URL**.
2. **New → Web Service** → this repo, Root Directory `backend`, Build `npm install`, Start `npm start`.
3. Environment: `DATABASE_URL` (Internal URL), `JWT_SECRET`, `CLOUDINARY_*`, `CORS_ORIGINS`. Leave `DB_SSL=false` with the internal URL.
4. Tables are created automatically on first boot. Create the admin once from the Render Shell: `npm run seed`.
