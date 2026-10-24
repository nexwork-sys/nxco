-- NXCO — PostgreSQL schema (PostgreSQL 12+; works on Render Postgres). Safe to run more than once.
-- No need to create tables by hand: the server runs this file on every boot (or run `npm run migrate`).
-- Image columns hold full Cloudinary URLs (https://res.cloudinary.com/...).
-- All timestamps are TIMESTAMPTZ (stored in UTC). Flag columns stay SMALLINT 0/1 so the API code is unchanged.

-- MySQL's "ON UPDATE CURRENT_TIMESTAMP" is emulated with this trigger function.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    employee_id VARCHAR(64) NOT NULL,
    name VARCHAR(150) NOT NULL,
    mobile VARCHAR(30) NOT NULL,
    designation VARCHAR(100) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('Admin','Marketing','Supervisor','Manager','Operator','Driver')),
    password_hash VARCHAR(100) NOT NULL,
    active SMALLINT NOT NULL DEFAULT 1,
    lat DOUBLE PRECISION NULL,
    lng DOUBLE PRECISION NULL,
    location_updated_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_users_employee_id UNIQUE (employee_id)
);

CREATE TABLE IF NOT EXISTS company_settings (
    id INT PRIMARY KEY,
    company_lat DOUBLE PRECISION NOT NULL DEFAULT 0,
    company_lng DOUBLE PRECISION NOT NULL DEFAULT 0,
    allowed_radius_meters INT NOT NULL DEFAULT 200,
    logo_path VARCHAR(500) NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    brand_name VARCHAR(150) NOT NULL,
    product_name VARCHAR(150) NOT NULL,
    quantity INT NOT NULL DEFAULT 0,
    rate NUMERIC(12,2) NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "Fill Form" only holds KYC + per-product rates. Payment mode (Cash/Credit)
-- and the cheque number/photo live on the ORDER (see orders table below).
CREATE TABLE IF NOT EXISTS parties (
    id SERIAL PRIMARY KEY,
    party_name VARCHAR(200) NOT NULL,
    owner_name VARCHAR(150) NOT NULL,
    mobile VARCHAR(30) NOT NULL,
    water_brand VARCHAR(150) NOT NULL DEFAULT '',
    years_exp INT NOT NULL DEFAULT 0,
    vehicle_types VARCHAR(100) NOT NULL DEFAULT '',          -- comma separated: truck,pickup,magic,auto,toto
    area VARCHAR(150) NOT NULL DEFAULT '',
    city VARCHAR(150) NOT NULL DEFAULT '',
    address TEXT NULL,
    shop_image VARCHAR(500) NULL,
    owner_image VARCHAR(500) NULL,
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL,
    created_by INT NULL REFERENCES users(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved')),
    approved_by INT NULL REFERENCES users(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ NULL,
    aadhar_no VARCHAR(64) NOT NULL DEFAULT '',
    aadhar_image VARCHAR(500) NULL,
    pan_no VARCHAR(64) NOT NULL DEFAULT '',
    pan_image VARCHAR(500) NULL,
    gst_no VARCHAR(64) NOT NULL DEFAULT '',
    form_no VARCHAR(64) NOT NULL DEFAULT '',
    comment TEXT NULL,
    fill_form_completed SMALLINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_parties_status ON parties (status);

CREATE TABLE IF NOT EXISTS party_product_rates (
    party_id INT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
    product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    rate NUMERIC(12,2) NOT NULL,
    PRIMARY KEY (party_id, product_id)
);

CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    party_id INT NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
    created_by INT NULL REFERENCES users(id) ON DELETE SET NULL,
    comment TEXT NULL,
    gst_no VARCHAR(64) NOT NULL DEFAULT '',
    status VARCHAR(30) NOT NULL DEFAULT 'Pending'
        CHECK (status IN ('Pending','Confirmed','Ready to Dispatch','On the Way','Completed','Cancelled')),
    -- Chosen when the order is placed: Cash, or Credit (goods now, money later against a cheque).
    payment_mode VARCHAR(10) NOT NULL DEFAULT 'Cash' CHECK (payment_mode IN ('Cash','Credit')),
    cheque_no VARCHAR(64) NOT NULL DEFAULT '',
    cheque_image VARCHAR(500) NULL,
    -- Set by the driver/admin when the order is marked Completed with money in hand.
    payment_collected SMALLINT NULL,
    amount_collected NUMERIC(12,2) NULL,
    payment_method VARCHAR(10) NULL CHECK (payment_method IN ('Cash','Online')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_created_by ON orders (created_by, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_party ON orders (party_id);

CREATE TABLE IF NOT EXISTS order_items (
    id SERIAL PRIMARY KEY,
    order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INT NULL REFERENCES products(id) ON DELETE SET NULL,
    quantity INT NOT NULL,
    rate NUMERIC(12,2) NOT NULL      -- party's negotiated rate at the time of the order
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id);

CREATE TABLE IF NOT EXISTS order_documents (
    id SERIAL PRIMARY KEY,
    order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    url VARCHAR(500) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_documents_order ON order_documents (order_id);

-- Deleting an order automatically deletes its payment entries (ON DELETE CASCADE),
-- so the party's due figure is recomputed without that order.
CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    party_id INT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
    order_id INT NULL REFERENCES orders(id) ON DELETE CASCADE,
    amount NUMERIC(12,2) NOT NULL,
    method VARCHAR(10) NOT NULL CHECK (method IN ('Cash','Online')),
    collected_by INT NULL REFERENCES users(id) ON DELETE SET NULL,
    note VARCHAR(255) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payments_party ON payments (party_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments (order_id);

CREATE TABLE IF NOT EXISTS attendance (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date CHAR(10) NOT NULL,                       -- IST 'YYYY-MM-DD'
    time_in VARCHAR(8) NULL,                      -- 'HH:MM:SS'
    time_out VARCHAR(8) NULL,
    attendance_type VARCHAR(10) NOT NULL DEFAULT 'Office' CHECK (attendance_type IN ('Office','Field')),
    lat DOUBLE PRECISION NULL,
    lng DOUBLE PRECISION NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'Present',
    party_id INT NULL REFERENCES parties(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_attendance_user_date UNIQUE (user_id, date)
);

CREATE TABLE IF NOT EXISTS visits (
    id SERIAL PRIMARY KEY,
    party_id INT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
    visited_by INT NULL REFERENCES users(id) ON DELETE SET NULL,
    note TEXT NULL,
    date CHAR(10) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_visits_party ON visits (party_id, id);
CREATE INDEX IF NOT EXISTS idx_visits_date ON visits (date);

CREATE TABLE IF NOT EXISTS pjp (
    id SERIAL PRIMARY KEY,
    date CHAR(10) NOT NULL,
    assigned_to INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_by INT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_pjp_date_user UNIQUE (date, assigned_to)
);

CREATE TABLE IF NOT EXISTS pjp_parties (
    id SERIAL PRIMARY KEY,
    pjp_id INT NOT NULL REFERENCES pjp(id) ON DELETE CASCADE,
    party_id INT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
    CONSTRAINT uq_pjp_party UNIQUE (pjp_id, party_id)
);

CREATE TABLE IF NOT EXISTS targets (
    id SERIAL PRIMARY KEY,
    assigned_to INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assigned_by INT NULL REFERENCES users(id) ON DELETE SET NULL,
    month CHAR(7) NOT NULL,                       -- 'YYYY-MM'
    quantity_target INT NOT NULL,
    start_date CHAR(10) NOT NULL,
    end_date CHAR(10) NOT NULL,
    notes TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_targets_user_month UNIQUE (assigned_to, month)
);

-- Auto-update `updated_at` on every UPDATE (replaces MySQL's ON UPDATE CURRENT_TIMESTAMP).
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['users','company_settings','products','parties','orders','payments','attendance','pjp','targets']
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON %1$I', t);
        EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON %1$I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
    END LOOP;
END $$;
