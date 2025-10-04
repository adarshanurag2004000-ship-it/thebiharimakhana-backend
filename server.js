// --- SERVER.JS WITH DELIVERED & CANCELLED EMAIL NOTIFICATIONS ---

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const Joi = require('joi');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const he = require('he');
require('dotenv').config();
const sgMail = require('@sendgrid/mail');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const PDFDocument = require('pdfkit');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const app = express();
const port = process.env.PORT || 3000;

// Corrected Helmet configuration to allow inline scripts for the admin panel
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            "script-src": ["'self'", "'unsafe-inline'"],
        },
    },
}));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 150,
});
app.use(limiter);

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});


async function setupDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                price NUMERIC(10, 2) NOT NULL,
                description TEXT,
                image_url VARCHAR(2048),
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                sale_price NUMERIC(10, 2),
                stock_quantity INTEGER NOT NULL DEFAULT 10,
                is_featured BOOLEAN DEFAULT FALSE,
                category VARCHAR(100)
            );
        `);
        console.log('INFO: "products" table schema is up to date.');
        
        const checkColumnResult = await client.query(`
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'products' AND column_name = 'category'
        `);

        if (checkColumnResult.rowCount === 0) {
            console.log('ACTION: "category" column not found. Adding it now...');
            await client.query('ALTER TABLE products ADD COLUMN category VARCHAR(100);');
            console.log('SUCCESS: "category" column has been added to the "products" table.');
        } else {
            console.log('INFO: "category" column already exists. No action needed.');
        }

        await client.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY, customer_name VARCHAR(255) NOT NULL, phone_number VARCHAR(20) NOT NULL,
                address TEXT NOT NULL, cart_items JSONB, order_amount NUMERIC(10, 2) NOT NULL,
                razorpay_payment_id VARCHAR(255) NOT NULL, created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                user_uid VARCHAR(255),
                status VARCHAR(50) NOT NULL DEFAULT 'Processing',
                coupon_used VARCHAR(255),
                discount_amount NUMERIC(10, 2) DEFAULT 0
            );
        `);
        console.log('INFO: "orders" table is ready.');
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY, email VARCHAR(255) UNIQUE NOT NULL, firebase_uid VARCHAR(255) UNIQUE NOT NULL,
                phone VARCHAR(20) UNIQUE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                delete_code VARCHAR(6),
                delete_code_expires_at TIMESTAMP WITH TIME ZONE,
                deleted_at TIMESTAMP WITH TIME ZONE,
                is_blocked_from_reviewing BOOLEAN DEFAULT FALSE
            );
        `);
        console.log('INFO: "users" table is ready.');
        await client.query(`
            CREATE TABLE IF NOT EXISTS coupons (
                id SERIAL PRIMARY KEY,
                code VARCHAR(255) UNIQUE NOT NULL,
                discount_type VARCHAR(20) NOT NULL,
                discount_value NUMERIC(10, 2) NOT NULL,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('INFO: "coupons" table is ready.');
        await client.query(`
            CREATE TABLE IF NOT EXISTS reviews (
                id SERIAL PRIMARY KEY,
                product_name VARCHAR(255) NOT NULL,
                user_uid VARCHAR(255) NOT NULL,
                rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
                review_text TEXT,
                reviewer_name VARCHAR(255),
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                is_approved BOOLEAN DEFAULT TRUE
            );
        `);
        console.log('INFO: "reviews" table is ready.');
        await client.query(`
            CREATE TABLE IF NOT EXISTS addresses (
                id SERIAL PRIMARY KEY,
                user_uid VARCHAR(255) NOT NULL,
                full_name VARCHAR(255) NOT NULL,
                phone_number VARCHAR(20) NOT NULL,
                street VARCHAR(255) NOT NULL,
                locality VARCHAR(255) NOT NULL,
                city VARCHAR(100) NOT NULL,
                pincode VARCHAR(10) NOT NULL,
                state VARCHAR(100) NOT NULL,
                country VARCHAR(100) NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('INFO: "addresses" table is ready.');
        
        await client.query(`
            CREATE TABLE IF NOT EXISTS site_settings (
                setting_key VARCHAR(255) PRIMARY KEY,
                setting_value TEXT
            );
        `);
        console.log('INFO: "site_settings" table is ready.');
        
        await client.query(`
            INSERT INTO site_settings (setting_key, setting_value)
            VALUES 
                ('homepage_headline', 'Authentic Makhana from the Heart of Bihar'),
                ('homepage_subheadline', 'Experience the crunchy, healthy, and delicious superfood, delivered right to your doorstep.'),
                ('banner_text', 'Free Shipping on All Orders Above ₹500!'),
                ('primary_color', '#F97316'),
                ('body_font', 'Inter'),
                ('about_us_content', 'Bihari Makhana celebrates the rich heritage of Mithila, Bihar, a region renowned for producing over 90% of the world''s Fox Nuts. Our makhana is ethically sourced from local farmers who use traditional harvesting methods passed down through generations.\n\nWe are committed to delivering not just a snack, but a piece of our culture. Each kernel is carefully selected and roasted to perfection, ensuring a crunchy, guilt-free delight that''s as nutritious as it is delicious.'),
                ('policies_shipping', 'We ship all orders within 3-5 business days. Shipping is free on all orders above ₹500. For all other orders, a flat rate of ₹99 will be charged.'),
                ('policies_returns', 'Due to the nature of our products, we do not accept returns. However, if your order arrives damaged, please contact us at thebiharimakhana@gmail.com within 48 hours with a video of opening the package , and we will be happy to assist you.'),
                ('contact_email', 'thebiharimakhana@gmail.com'),
                ('contact_phone', '+91 7295901346'),
                ('contact_address', 'Bhagalpur, Bihar, India'),
                ('homepage_bg_image', '')
            ON CONFLICT (setting_key) DO NOTHING;
        `);
        console.log('INFO: Default site settings are populated.');

    } catch (err) {
        console.error('Error during database setup:', err);
    } finally {
        client.release();
    }
}
async function verifyToken(req, res, next) {
    const idToken = req.headers.authorization?.split('Bearer ')[1];
    if (!idToken) {
        return res.status(403).send('Unauthorized');
    }
    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.user = decodedToken;
        next();
    } catch (error) {
        res.status(403).send('Unauthorized');
    }
}

function generateInvoicePdf(order, callback) {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => {
        const pdfData = Buffer.concat(buffers);
        callback(pdfData);
    });
    doc.fontSize(20).font('Helvetica-Bold').text('The Bihari Makhana', { align: 'center' });
    doc.fontSize(10).font('Helvetica').text('Bhagalpur, Bihar, India', { align: 'center' });
    doc.moveDown(2);
    doc.fontSize(16).font('Helvetica-Bold').text('INVOICE', { align: 'left' });
    doc.fontSize(10).font('Helvetica');
    doc.text(`Invoice #: ${order.id}`);
    doc.text(`Order Date: ${new Date(order.created_at).toLocaleDateString('en-IN')}`);
    doc.moveDown();
    doc.text('Bill To:', { font: 'Helvetica-Bold' });
    doc.text(he.decode(order.customer_name));
    doc.text(he.decode(order.address));
    doc.text(`Phone: ${order.phone_number}`);
    doc.moveDown(2);
    const tableTop = doc.y;
    doc.font('Helvetica-Bold');
    doc.text('Item', 50, tableTop);
    doc.text('Qty', 300, tableTop, { width: 90, align: 'right' });
    doc.text('Unit Price', 370, tableTop, { width: 90, align: 'right' });
    doc.text('Total', 0, tableTop, { align: 'right' });
    doc.moveTo(50, doc.y + 5).lineTo(550, doc.y + 5).stroke();
    doc.font('Helvetica');
    doc.moveDown();
    let subtotal = 0;
    for (const key in order.cart_items) {
        const item = order.cart_items[key];
        const itemTotal = item.price * item.quantity;
        subtotal += itemTotal;
        const y = doc.y;
        doc.text(key.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '), 50, y);
        doc.text(item.quantity, 300, y, { width: 90, align: 'right' });
        doc.text(`₹${item.price.toFixed(2)}`, 370, y, { width: 90, align: 'right' });
        doc.text(`₹${itemTotal.toFixed(2)}`, 0, y, { align: 'right' });
        doc.moveDown();
    }
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown();
    const summaryTop = doc.y;
    doc.font('Helvetica');
    doc.text('Subtotal:', 350, summaryTop, { align: 'right' });
    doc.text(`₹${subtotal.toFixed(2)}`, 0, summaryTop, { align: 'right' });
    if (order.discount_amount > 0) {
        doc.moveDown(0.5);
        const discountY = doc.y;
        doc.text('Discount:', 350, discountY, { align: 'right' });
        doc.text(`- ₹${Number(order.discount_amount).toFixed(2)}`, 0, discountY, { align: 'right' });
    }
    const shippingCost = Number(order.order_amount) - (subtotal - Number(order.discount_amount));
    doc.moveDown(0.5);
    const shippingY = doc.y;
    doc.text('Shipping:', 350, shippingY, { align: 'right' });
    doc.text(`₹${shippingCost.toFixed(2)}`, 0, shippingY, { align: 'right' });
    doc.moveDown();
    doc.font('Helvetica-Bold');
    const totalY = doc.y;
    doc.text('Grand Total:', 350, totalY, { align: 'right' });
    doc.text(`₹${Number(order.order_amount).toFixed(2)}`, 0, totalY, { align: 'right' });
    doc.moveDown(2);
    const isCOD = order.razorpay_payment_id.startsWith('cod_');
    doc.font('Helvetica-Bold').fontSize(12);
    if (isCOD) {
        doc.text('Payment Status: Cash on Delivery (COD)', { align: 'left' });
        doc.text(`Amount to be Paid on Delivery: ₹${Number(order.order_amount).toFixed(2)}`, { align: 'left' });
    } else {
        doc.text('Payment Status: PAID', { align: 'left' });
        doc.text(`Payment ID: ${order.razorpay_payment_id}`, { align: 'left' });
    }
    doc.end();
}

async function sendOrderConfirmationEmail(customerEmail, customerName, order, attachmentPdf) {
    const orderDate = new Date(order.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const msg = { 
        to: customerEmail, 
        from: 'thebiharimakhana@gmail.com', 
        subject: `Your The Bihari Makhana Order #${order.id} is Confirmed!`, 
        html: `<div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #ddd; padding: 20px;"><h1 style="color: #F97316; text-align: center;">Thank You For Your Order!</h1><p>Hi ${he.encode(customerName)},</p><p>We've received your order and will process it shortly. Your invoice is attached to this email.</p><p><strong>Order ID:</strong> #${order.id}</p><p><strong>Order Date:</strong> ${orderDate}</p><p style="font-size: 12px; color: #777; text-align: center;">For any questions, contact us at <a href="mailto:thebiharimakhana@gmail.com">thebiharimakhana@gmail.com</a>.</p></div>`,
        attachments: [{ content: attachmentPdf.toString('base64'), filename: `invoice-${order.id}.pdf`, type: 'application/pdf', disposition: 'attachment' }]
    };
    try { await sgMail.send(msg); console.log('Confirmation email with invoice sent to', customerEmail); } catch (error) { console.error('Error sending confirmation email:', error.response.body); }
}

async function sendOrderCancellationEmail(customerEmail, customerName, orderId) { /* ... same as before ... */ }
async function sendDeletionCodeEmail(customerEmail, code) { /* ... same as before ... */ }
async function sendOrderShippedEmail(customerEmail, customerName, orderId) { /* ... same as before ... */ }
async function sendOrderDeliveredEmail(customerEmail, customerName, orderId) { /* ... same as before ... */ }

// --- Public API Routes ---
app.get('/', async (req, res) => { /* ... same as before ... */ });
app.post('/api/check-phone', async (req, res) => { /* ... same as before ... */ });
app.get('/api/products', async (req, res) => { /* ... same as before ... */ });
app.get('/api/site-settings', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT setting_key, setting_value FROM site_settings');
        const settings = rows.reduce((acc, row) => { acc[row.setting_key] = row.setting_value; return acc; }, {});
        res.json(settings);
    } catch (err) { console.error('Error fetching site settings:', err); res.status(500).json({ error: 'Could not fetch site settings.' }); }
});
app.get('/api/featured-products', async (req, res) => { /* ... same as before ... */ });
app.post('/api/apply-coupon', async (req, res) => { /* ... same as before ... */ });
app.post('/checkout', verifyToken, async (req, res) => { /* ... same as before ... */ });
app.post('/api/user-login', async (req, res) => { /* ... same as before ... */ });
app.get('/api/my-orders', verifyToken, async (req, res) => { /* ... same as before ... */ });
app.post('/api/request-deletion-code', verifyToken, async (req, res) => { /* ... same as before ... */ });
app.post('/api/verify-deletion', verifyToken, async (req, res) => { /* ... same as before ... */ });
app.get('/api/products/:productName/reviews', async (req, res) => { /* ... same as before ... */ });
app.post('/api/submit-review', verifyToken, async (req, res) => { /* ... same as before ... */ });
app.get('/api/my-addresses', verifyToken, async (req, res) => { /* ... same as before ... */ });
app.post('/api/my-addresses', verifyToken, async (req, res) => { /* ... same as before ... */ });
app.delete('/api/my-addresses/:id', verifyToken, async (req, res) => { /* ... same as before ... */ });
app.get('/api/active-coupons', async (req, res) => { /* ... same as before ... */ });
app.get('/api/my-orders/:orderId/invoice', verifyToken, async (req, res) => { /* ... same as before ... */ });// --- Admin Routes ---

const checkAdminAuth = (req, res, next) => {
    if (req.cookies.admin_session && req.cookies.admin_session === process.env.ADMIN_SESSION_SECRET) {
        next();
    } else {
        res.redirect('/admin/login');
    }
};

const getAdminHeaderHTML = (currentPageTitle) => {
    return `
        <!DOCTYPE html><html><head><title>${currentPageTitle} - Admin Panel</title>
        <style>
            body { font-family: sans-serif; margin: 0; background-color: #f4f4f9; }
            .admin-nav { background-color: #333; padding: 1em; display: flex; justify-content: space-between; align-items: center; }
            .admin-nav a { color: white; text-decoration: none; margin-right: 1.5em; font-weight: bold; }
            .admin-nav a:hover { text-decoration: underline; }
            .admin-container { padding: 2em; }
            table { border-collapse: collapse; width: 100%; background-color: white; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
            th, td { border: 1px solid #ddd; padding: 12px; text-align: left; }
            th { background-color: #f2f2f2; }
            img { max-width: 50px; }
            .add-form { margin-top: 1em; padding: 1.5em; border: 1px solid #ddd; background-color: white; }
            .logout-btn { background-color: #f44336; color: white; padding: 0.5em 1em; border: none; border-radius: 4px; cursor: pointer; text-decoration: none; }
            .form-group{margin-bottom:1em;} label{display:block;margin-bottom:0.5em; font-weight: bold;} input, select, textarea, button{padding:8px; width: 100%; box-sizing: border-box;}
            input[type="color"] { padding: 0; height: 40px; }
            button, .button-style { padding: 10px 15px; border: none; cursor: pointer; border-radius: 4px; font-size: 16px;}
            .soft-delete-btn { background-color: #f0ad4e; color: white; }
            .permanent-delete-btn { background-color: #d9534f; color: white; }
        </style>
        </head><body>
        <nav class="admin-nav">
            <div>
                <a href="/admin/dashboard">Dashboard</a>
                <a href="/admin/products">Products</a>
                <a href="/admin/orders">Orders</a>
                <a href="/admin/users">Users</a>
                <a href="/admin/coupons">Coupons</a>
                <a href="/admin/reviews">Reviews</a>
                <a href="/admin/settings">Site Settings</a>
            </div>
            <div>
                <a href="/admin/logout" class="logout-btn">Logout</a>
            </div>
        </nav>
        <div class="admin-container">
    `;
};

app.get('/admin/login', (req, res) => { /* ... same as before ... */ });
app.post('/admin/login', (req, res) => { /* ... same as before ... */ });
app.get('/admin/logout', (req, res) => { /* ... same as before ... */ });
app.get('/admin/dashboard', checkAdminAuth, (req, res) => { /* ... same as before ... */ });
app.get('/admin/products', checkAdminAuth, async (req, res) => { /* ... same as before ... */ });
app.post('/admin/toggle-featured/:id', checkAdminAuth, async (req, res) => { /* ... same as before ... */ });
app.post('/admin/add-product', checkAdminAuth, async (req, res) => { /* ... same as before ... */ });
app.get('/admin/edit-product/:id', checkAdminAuth, async (req, res) => { /* ... same as before ... */ });
app.post('/admin/update-product/:id', checkAdminAuth, async (req, res) => { /* ... same as before ... */ });
app.post('/admin/delete-product/:id', checkAdminAuth, async (req, res) => { /* ... same as before ... */ });
app.get('/admin/users', checkAdminAuth, async (req, res) => { /* ... same as before ... */ });
app.post('/admin/soft-delete-user/:uid', checkAdminAuth, async (req, res) => { /* ... same as before ... */ });
app.post('/admin/permanent-delete-user/:uid', checkAdminAuth, async (req, res) => { /* ... same as before ... */ });
app.get('/admin/orders', checkAdminAuth, async (req, res) => { /* ... same as before ... */ });
app.post('/admin/update-order-status/:id', checkAdminAuth, async (req, res) => { /* ... same as before ... */ });
app.post('/admin/delete-order/:id', checkAdminAuth, async (req, res) => { /* ... same as before ... */ });
app.get('/admin/coupons', checkAdminAuth, async (req, res) => { /* ... same as before ... */ });
app.post('/admin/add-coupon', checkAdminAuth, async (req, res) => { /* ... same as before ... */ });
app.post('/admin/delete-coupon/:id', checkAdminAuth, async (req, res) => { /* ... same as before ... */ });
app.get('/admin/reviews', checkAdminAuth, async (req, res) => { /* ... same as before ... */ });
app.post('/admin/delete-review/:id', checkAdminAuth, async (req, res) => { /* ... same as before ... */ });
app.post('/admin/block-user/:uid', checkAdminAuth, async (req, res) => { /* ... same as before ... */ });

app.get('/admin/settings', checkAdminAuth, async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT setting_key, setting_value FROM site_settings');
        const settings = rows.reduce((acc, row) => { acc[row.setting_key] = row.setting_value; return acc; }, {});
        const fonts = ['Inter', 'Poppins', 'Roboto', 'Merriweather'];
        const fontOptions = fonts.map(font => `<option value="${font}" ${settings.body_font === font ? 'selected' : ''}>${font}</option>`).join('');
        const header = getAdminHeaderHTML('Site Settings');
        res.send(`
            ${header}
            <h1>Edit Site Content & Theme</h1>
            <p>Changes made here will be reflected on your live website immediately.</p>
            
            <div class="form-group">
                <label for="section-selector">Choose a section to edit:</label>
                <select id="section-selector">
                    <option value="content">Homepage & Banner</option>
                    <option value="theme">Theme & Fonts</option>
                    <option value="about">About Us Page</option>
                    <option value="policies">Policies Page</option>
                    <option value="contact">Contact Page</option>
                </select>
            </div>

            <form action="/admin/settings" method="POST" class="add-form">
                <div id="content-section" style="display: none;">
                    <h2>Homepage & Banner Content</h2>
                    <div class="form-group">
                        <label for="homepage_headline">Homepage Main Headline:</label>
                        <input type="text" id="homepage_headline" name="homepage_headline" value="${he.encode(settings.homepage_headline || '')}">
                    </div>
                    <div class="form-group">
                        <label for="homepage_subheadline">Homepage Sub-Headline:</label>
                        <textarea id="homepage_subheadline" name="homepage_subheadline" rows="3">${he.encode(settings.homepage_subheadline || '')}</textarea>
                    </div>
                    <div class="form-group">
                        <label for="banner_text">Scrolling Banner Text (Top Bar):</label>
                        <input type="text" id="banner_text" name="banner_text" value="${he.encode(settings.banner_text || '')}">
                    </div>
                    <div class="form-group">
                        <label for="homepage_bg_image">Homepage Background Image URL:</label>
                        <input type="text" id="homepage_bg_image" name="homepage_bg_image" value="${he.encode(settings.homepage_bg_image || '')}" placeholder="Leave blank to use theme color">
                    </div>
                    </div>

                <div id="theme-section" style="display: none;">
                    <h2>Theme & Fonts</h2>
                    <div class="form-group"><label for="primary_color">Primary Color:</label><input type="color" id="primary_color" name="primary_color" value="${he.encode(settings.primary_color || '#F97316')}"></div>
                    <div class="form-group"><label for="body_font">Main Website Font:</label><select id="body_font" name="body_font">${fontOptions}</select></div>
                </div>

                <div id="about-section" style="display: none;">
                    <h2>About Us Page Content</h2>
                    <div class="form-group"><label for="about_us_content">Content:</label><textarea id="about_us_content" name="about_us_content" rows="10">${he.encode(settings.about_us_content || '')}</textarea></div>
                </div>

                <div id="policies-section" style="display: none;">
                    <h2>Policies Page Content</h2>
                    <div class="form-group"><label for="policies_shipping">Shipping Policy:</label><textarea id="policies_shipping" name="policies_shipping" rows="5">${he.encode(settings.policies_shipping || '')}</textarea></div>
                    <div class="form-group"><label for="policies_returns">Return & Refund Policy:</label><textarea id="policies_returns" name="policies_returns" rows="5">${he.encode(settings.policies_returns || '')}</textarea></div>
                </div>
                
                <div id="contact-section" style="display: none;">
                    <h2>Contact Page Information</h2>
                    <div class="form-group"><label for="contact_email">Email:</label><input type="email" id="contact_email" name="contact_email" value="${he.encode(settings.contact_email || '')}"></div>
                    <div class="form-group"><label for="contact_phone">Phone:</label><input type="text" id="contact_phone" name="contact_phone" value="${he.encode(settings.contact_phone || '')}"></div>
                    <div class="form-group"><label for="contact_address">Address:</label><input type="text" id="contact_address" name="contact_address" value="${he.encode(settings.contact_address || '')}"></div>
                </div>

                <hr style="margin: 2em 0;"><button type="submit" style="background-color: #28a745; color: white;">Save All Settings</button>
            </form>

            <script>
                document.addEventListener('DOMContentLoaded', function() {
                    const selector = document.getElementById('section-selector');
                    const sections = {
                        content: document.getElementById('content-section'),
                        theme: document.getElementById('theme-section'),
                        about: document.getElementById('about-section'),
                        policies: document.getElementById('policies-section'),
                        contact: document.getElementById('contact-section')
                    };
                    function showSection(sectionId) {
                        for (const key in sections) { if(sections[key]) { sections[key].style.display = 'none'; } }
                        if (sections[sectionId]) { sections[sectionId].style.display = 'block'; }
                    }
                    selector.addEventListener('change', function() { showSection(this.value); });
                    showSection(selector.value);
                });
            </script>
            </div></body></html>
        `);
    } catch (err) { console.error("Error loading settings page:", err); res.status(500).send('Error loading settings page.'); }
});

app.post('/admin/settings', checkAdminAuth, async (req, res) => {
    try {
        const { homepage_headline, homepage_subheadline, banner_text, primary_color, body_font, about_us_content, policies_shipping, policies_returns, contact_email, contact_phone, contact_address, homepage_bg_image } = req.body;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const settingsToUpdate = { homepage_headline, homepage_subheadline, banner_text, primary_color, body_font, about_us_content, policies_shipping, policies_returns, contact_email, contact_phone, contact_address, homepage_bg_image };
            for (const key in settingsToUpdate) {
                 if (settingsToUpdate[key] !== undefined) {
                    await client.query(`INSERT INTO site_settings (setting_key, setting_value) VALUES ($1, $2) ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2`, [key, settingsToUpdate[key]]);
                }
            }
            await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
        res.redirect('/admin/settings');
    } catch (err) { console.error("Error saving site settings:", err); res.status(500).send('Error saving settings.'); }
});


app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something broke!');
});

app.listen(port, () => {
    console.log(`Server is listening on port ${port}`);
    setupDatabase();
});
