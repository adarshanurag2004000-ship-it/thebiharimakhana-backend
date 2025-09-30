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

app.use(helmet());
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
        
        console.log('INFO: Checking if "category" column exists in "products" table...');
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

    // Header
    doc.fontSize(20).font('Helvetica-Bold').text('The Bihari Makhana', { align: 'center' });
    doc.fontSize(10).font('Helvetica').text('Bhagalpur, Bihar, India', { align: 'center' });
    doc.moveDown(2);

    // Invoice Details
    doc.fontSize(16).font('Helvetica-Bold').text('INVOICE', { align: 'left' });
    doc.fontSize(10).font('Helvetica');
    doc.text(`Invoice #: ${order.id}`);
    doc.text(`Order Date: ${new Date(order.created_at).toLocaleDateString('en-IN')}`);
    doc.moveDown();
    
    // Customer Details
    doc.text('Bill To:', { font: 'Helvetica-Bold' });
    doc.text(he.decode(order.customer_name));
    doc.text(he.decode(order.address));
    doc.text(`Phone: ${order.phone_number}`);
    doc.moveDown(2);
    
    // Items Table Header
    const tableTop = doc.y;
    doc.font('Helvetica-Bold');
    doc.text('Item', 50, tableTop);
    doc.text('Qty', 300, tableTop, { width: 90, align: 'right' });
    doc.text('Unit Price', 370, tableTop, { width: 90, align: 'right' });
    doc.text('Total', 0, tableTop, { align: 'right' });
    doc.moveTo(50, doc.y + 5).lineTo(550, doc.y + 5).stroke();
    doc.font('Helvetica');
    doc.moveDown();

    // Items Table Rows
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

    // Summary
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

    // Payment Status Logic
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
        html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #ddd; padding: 20px;">
                <h1 style="color: #F97316; text-align: center;">Thank You For Your Order!</h1>
                <p>Hi ${he.encode(customerName)},</p>
                <p>We've received your order and will process it shortly. Your invoice is attached to this email.</p>
                <p><strong>Order ID:</strong> #${order.id}</p>
                <p><strong>Order Date:</strong> ${orderDate}</p>
                <p style="font-size: 12px; color: #777; text-align: center;">For any questions, contact us at <a href="mailto:thebiharimakhana@gmail.com">thebiharimakhana@gmail.com</a>.</p>
            </div>`,
        attachments: [{
            content: attachmentPdf.toString('base64'),
            filename: `invoice-${order.id}.pdf`,
            type: 'application/pdf',
            disposition: 'attachment'
        }]
    };
    try {
        await sgMail.send(msg);
        console.log('Confirmation email with invoice sent to', customerEmail);
    } catch (error) {
        console.error('Error sending confirmation email:', error.response.body);
    }
}

async function sendOrderCancellationEmail(customerEmail, customerName, orderId) {
    const emailHtml = `
      <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #ddd; padding: 20px;">
        <h1 style="color: #EF4444; text-align: center;">Your Order Has Been Cancelled</h1><p>Hi ${he.encode(customerName)},</p><p>This is to confirm that your order #${orderId} has been successfully cancelled. If you have already paid, a refund will be processed shortly.</p>
        <p>If you did not request this cancellation, please contact our support team immediately.</p><p style="font-size: 12px; color: #777; text-align: center;">This is an automated mail, please do not reply. For any questions, contact us at <a href="mailto:thebiharimakhana@gmail.com">thebiharimakhana@gmail.com</a>.</p>
      </div>`;
    const msg = { to: customerEmail, from: 'thebiharimakhana@gmail.com', subject: `Regarding Your The Bihari Makhana Order #${orderId}`, html: emailHtml };
    try {
        await sgMail.send(msg);
        console.log('Cancellation email sent to', customerEmail);
    } catch (error) {
        console.error('Error sending cancellation email:', error);
    }
}
async function sendDeletionCodeEmail(customerEmail, code) {
    const emailHtml = `
      <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #ddd; padding: 20px;">
        <h1 style="color: #EF4444; text-align: center;">Account Deletion Request</h1>
        <p>We have received a request to delete your account.</p>
        <p>To confirm this action, please use the following verification code. The code is valid for 10 minutes.</p>
        <p style="font-size: 24px; font-weight: bold; text-align: center; letter-spacing: 5px; margin: 20px 0; background-color: #f2f2f2; padding: 15px;">${code}</p>
        <p>If you did not request this, please ignore this email and your account will remain safe.</p>
      </div>`;
    const msg = { to: customerEmail, from: 'thebiharimakhana@gmail.com', subject: 'Your Account Deletion Code for The Bihari Makhana', html: emailHtml };
    try {
        await sgMail.send(msg);
        console.log('Deletion code email sent to', customerEmail);
    } catch (error) {
        console.error('Error sending deletion code email:', error);
    }
}
async function sendOrderShippedEmail(customerEmail, customerName, orderId) {
    const emailHtml = `
      <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #ddd; padding: 20px;">
        <h1 style="color: #3B82F6; text-align: center;">Your Order has Shipped!</h1>
        <p>Hi ${he.encode(customerName)},</p>
        <p>Great news! Your order #${orderId} from The Bihari Makhana has been shipped and is on its way to you.</p>
        <p>Thank you for your patience.</p>
      </div>`;
    const msg = { to: customerEmail, from: 'thebiharimakhana@gmail.com', subject: `Your The Bihari Makhana Order #${orderId} has Shipped!`, html: emailHtml };
    try {
        await sgMail.send(msg);
        console.log('Shipped notification email sent to', customerEmail);
    } catch (error) {
        console.error('Error sending shipped notification email:', error);
    }
}

// START: NEW FUNCTION FOR "DELIVERED" EMAIL
async function sendOrderDeliveredEmail(customerEmail, customerName, orderId) {
    const emailHtml = `
      <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #ddd; padding: 20px;">
        <h1 style="color: #10B981; text-align: center;">Your Order Has Been Delivered!</h1>
        <p>Hi ${he.encode(customerName)},</p>
        <p>We're happy to let you know that your order #${orderId} has been delivered successfully.</p>
        <p>We hope you enjoy your products! We would be grateful if you could <a href="https://thebiharimakhana.netlify.app/my-orders.html">leave a review</a> for the products you purchased.</p>
        <p>Thank you for shopping with us!</p>
      </div>`;
    const msg = { to: customerEmail, from: 'thebiharimakhana@gmail.com', subject: `Your The Bihari Makhana Order #${orderId} Has Been Delivered!`, html: emailHtml };
    try {
        await sgMail.send(msg);
        console.log('Delivered notification email sent to', customerEmail);
    } catch (error) {
        console.error('Error sending delivered notification email:', error);
    }
}
// END: NEW FUNCTION FOR "DELIVERED" EMAIL

// --- Public API Routes (Full code included) ---
app.get('/', async (req, res) => {
    try {
        await pool.query('SELECT NOW()');
        res.send('The Bihari Makhana Backend is running and connected to the database.');
    } catch (err) {
        res.status(500).send('Backend is running, but could not connect to the database.');
    }
});
app.post('/api/check-phone', async (req, res) => {
    const { phone } = req.body;
    if (!phone) {
        return res.status(400).json({ error: 'Phone number is required.' });
    }
    try {
        const result = await pool.query('SELECT id FROM users WHERE phone = $1 AND deleted_at IS NULL', [phone]);
        if (result.rows.length > 0) {
            res.json({ isAvailable: false });
        } else {
            res.json({ isAvailable: true });
        }
    } catch (err) {
        console.error('Error checking phone number:', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});
app.get('/api/products', async (req, res) => {
    try {
        const { search, sort, category } = req.query;
        let query = 'SELECT * FROM products WHERE stock_quantity > 0';
        const queryParams = [];

        if (category) {
            queryParams.push(category);
            query += ` AND category = $${queryParams.length}`;
        }

        if (search) {
            queryParams.push(`%${search}%`);
            query += ` AND (name ILIKE $${queryParams.length} OR description ILIKE $${queryParams.length})`;
        }
        
        let orderByClause = ' ORDER BY created_at DESC';
        switch (sort) {
            case 'price-asc': orderByClause = ' ORDER BY COALESCE(sale_price, price) ASC'; break;
            case 'price-desc': orderByClause = ' ORDER BY COALESCE(sale_price, price) DESC'; break;
            case 'name-asc': orderByClause = ' ORDER BY name ASC'; break;
            case 'name-desc': orderByClause = ' ORDER BY name DESC'; break;
        }

        query += orderByClause;
        const { rows } = await pool.query(query, queryParams);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching products:', err);
        res.status(500).send('Error fetching products');
    }
});
app.get('/api/featured-products', async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT * FROM products WHERE is_featured = TRUE AND stock_quantity > 0 ORDER BY created_at DESC'
        );
        res.json(rows);
    } catch (err) {
        console.error('Error fetching featured products:', err);
        res.status(500).send('Error fetching featured products');
    }
});
app.post('/api/apply-coupon', async (req, res) => {
    const { cart, couponCode } = req.body;
    if (!cart || Object.keys(cart).length === 0) {
      return res.status(400).json({ success: false, message: 'Cart data is required.' });
    }
    try {
        let subtotal = 0;
        for (const productName in cart) {
            subtotal += cart[productName].price * cart[productName].quantity;
        }
        let shippingCost = subtotal >= 500 ? 0 : 99;
        let discount = 0;
        let appliedCoupon = null;
        if (couponCode) {
            const couponResult = await pool.query('SELECT * FROM coupons WHERE code = $1 AND is_active = TRUE', [couponCode.toUpperCase()]);
            if (couponResult.rows.length > 0) {
                const coupon = couponResult.rows[0];
                appliedCoupon = coupon.code;
                if (coupon.discount_type === 'percentage') {
                    discount = subtotal * (parseFloat(coupon.discount_value) / 100);
                } else {
                    discount = parseFloat(coupon.discount_value);
                }
                discount = Math.min(subtotal, discount);
            } else {
                return res.status(404).json({ success: false, message: "Invalid or inactive coupon code."});
            }
        }
        const total = subtotal - discount + shippingCost;
        res.json({ success: true, subtotal, shippingCost, discount, total, appliedCoupon });
    } catch (err) {
        console.error("Error in apply-coupon:", err);
        res.status(500).json({ success: false, message: "Error applying coupon."});
    }
});
app.post('/checkout', verifyToken, async (req, res) => {
    const { cart, addressDetails, paymentId, couponCode } = req.body;
    const user = req.user; 
    if (!cart || !addressDetails || !paymentId || Object.keys(cart).length === 0) {
        return res.status(400).json({ success: false, message: 'Missing required order information.' });
    }
    try {
        let subtotal = 0;
        for (const productName in cart) {
            subtotal += cart[productName].price * cart[productName].quantity;
        }
        let shippingCost = subtotal >= 500 ? 0 : 99;
        let discount = 0;
        let appliedCouponCode = null;
        if (couponCode) {
            const couponResult = await pool.query('SELECT * FROM coupons WHERE code = $1 AND is_active = TRUE', [couponCode.toUpperCase()]);
            if (couponResult.rows.length > 0) {
                const coupon = couponResult.rows[0];
                appliedCouponCode = coupon.code;
                if (coupon.discount_type === 'percentage') {
                    discount = subtotal * (parseFloat(coupon.discount_value) / 100);
                } else {
                    discount = parseFloat(coupon.discount_value);
                }
                discount = Math.min(subtotal, discount);
            }
        }
        const totalAmount = subtotal - discount + shippingCost;
        const query = `
            INSERT INTO orders (customer_name, phone_number, address, cart_items, order_amount, user_uid, razorpay_payment_id, coupon_used, discount_amount)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *
        `;
        const values = [
            addressDetails.name, addressDetails.phone, addressDetails.address, 
            JSON.stringify(cart), totalAmount, user.uid, paymentId,
            appliedCouponCode, discount
        ];
        const orderResult = await pool.query(query, values);
        const newOrder = orderResult.rows[0];

        generateInvoicePdf(newOrder, (pdfData) => {
            sendOrderConfirmationEmail(user.email, addressDetails.name, newOrder, pdfData);
        });
        
        res.json({ success: true, message: 'Order placed successfully!' });
    } catch (err) {
        console.error('Error during checkout:', err);
        res.status(500).json({ success: false, message: 'An internal server error occurred.' });
    }
});
app.post('/api/user-login', async (req, res) => {
    const { email, uid, phone } = req.body;
    if (!email || !uid) {
        return res.status(400).json({ error: 'Email and UID are required.' });
    }
    try {
        const existingUser = await pool.query('SELECT id FROM users WHERE firebase_uid = $1', [uid]);
        if (existingUser.rows.length === 0) {
            await pool.query('INSERT INTO users (email, firebase_uid, phone) VALUES ($1, $2, $3)', [email, uid, phone]);
            console.log(`SUCCESS: New user registered in database: ${email}`);
        } else {
            console.log(`INFO: User ${email} already exists in database. Skipping insert.`);
        }
        res.status(200).json({ success: true, message: 'User session handled.' });
    } catch (err) {
        console.error("Error in /api/user-login:", err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});
app.get('/api/my-orders', verifyToken, async (req, res) => {
    try {
        const userUid = req.user.uid;
        const { rows } = await pool.query(
            'SELECT id, order_amount, created_at, cart_items, status FROM orders WHERE user_uid = $1 ORDER BY created_at DESC', 
            [userUid]
        );
        res.json(rows);
    } catch (err) {
        console.error("Error fetching user orders:", err);
        res.status(500).send('Error fetching orders.');
    }
});
app.post('/api/request-deletion-code', verifyToken, async (req, res) => {
    const { uid, email } = req.user;
    const code = crypto.randomInt(100000, 999999).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    try {
        await pool.query(
            'UPDATE users SET delete_code = $1, delete_code_expires_at = $2 WHERE firebase_uid = $3',
            [code, expiresAt, uid]
        );
        await sendDeletionCodeEmail(email, code);
        res.status(200).json({ success: true, message: 'Deletion code sent to your email.' });
    } catch (err) {
        console.error('Error requesting deletion code:', err);
        res.status(500).json({ success: false, message: 'Could not send deletion code.' });
    }
});
app.post('/api/verify-deletion', verifyToken, async (req, res) => {
    const { uid } = req.user;
    const { code } = req.body;
    if (!code) {
        return res.status(400).json({ success: false, message: 'Verification code is required.' });
    }
    try {
        const { rows } = await pool.query(
            'SELECT delete_code, delete_code_expires_at FROM users WHERE firebase_uid = $1',
            [uid]
        );
        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        const user = rows[0];
        const now = new Date();
        if (user.delete_code !== code) {
            return res.status(400).json({ success: false, message: 'Invalid verification code.' });
        }
        if (now > user.delete_code_expires_at) {
            return res.status(400).json({ success: false, message: 'Verification code has expired.' });
        }
        await pool.query('UPDATE users SET deleted_at = NOW() WHERE firebase_uid = $1', [uid]);
        await admin.auth().deleteUser(uid);
        console.log(`Successfully soft-deleted user ${uid} after code verification.`);
        res.status(200).json({ success: true, message: 'Account deleted successfully.' });
    } catch (err) {
        console.error(`Failed to verify and delete user ${uid}:`, err);
        res.status(500).json({ success: false, message: 'An error occurred during account deletion.' });
    }
});
app.get('/api/products/:productName/reviews', async (req, res) => {
    try {
        const { productName } = req.params;
        const nameWithHyphen = productName.replace(/ /g, '-');
        const nameWithSpace = productName.replace(/-/g, ' ');
        const { rows } = await pool.query(
            'SELECT rating, review_text, reviewer_name, created_at FROM reviews WHERE (product_name = $1 OR product_name = $2) AND is_approved = TRUE ORDER BY created_at DESC',
            [nameWithHyphen, nameWithSpace]
        );
        res.json(rows);
    } catch (err) {
        console.error("Error fetching reviews:", err);
        res.status(500).send('Error fetching reviews.');
    }
});
app.post('/api/submit-review', verifyToken, async (req, res) => {
    const { uid, name } = req.user;
    const { productName, rating, reviewText } = req.body;
    if (!productName || !rating) {
        return res.status(400).json({ success: false, message: 'Product and rating are required.' });
    }
    try {
        const userResult = await pool.query('SELECT is_blocked_from_reviewing FROM users WHERE firebase_uid = $1', [uid]);
        if (userResult.rows.length > 0 && userResult.rows[0].is_blocked_from_reviewing) {
            return res.status(403).json({ success: false, message: 'You are not permitted to leave reviews.' });
        }
        const reviewerName = name;
        const productNameWithHyphens = productName.replace(/ /g, '-');
        const productNameWithSpaces = productName.replace(/-/g, ' ');
        const ordersResult = await pool.query(
            `SELECT id FROM orders WHERE user_uid = $1 AND (cart_items ->> $2 IS NOT NULL OR cart_items ->> $3 IS NOT NULL) AND status = 'Delivered'`,
            [uid, productNameWithHyphens, productNameWithSpaces]
        );
        if (ordersResult.rows.length === 0) {
            return res.status(403).json({ success: false, message: 'You can only review products you have purchased and received.' });
        }
        const existingReview = await pool.query(
            'SELECT id FROM reviews WHERE user_uid = $1 AND (product_name = $2 OR product_name = $3)',
            [uid, productNameWithHyphens, productNameWithSpaces]
        );
        if (existingReview.rows.length > 0) {
            return res.status(409).json({ success: false, message: 'You have already reviewed this product.' });
        }
        await pool.query(
            'INSERT INTO reviews (product_name, user_uid, rating, review_text, reviewer_name) VALUES ($1, $2, $3, $4, $5)',
            [productNameWithHyphens, uid, rating, reviewText, reviewerName]
        );
        res.status(201).json({ success: true, message: 'Thank you! Your review has been submitted.' });
    } catch (err) {
        console.error("Error submitting review:", err);
        res.status(500).json({ success: false, message: 'An error occurred while submitting your review.' });
    }
});
app.get('/api/my-addresses', verifyToken, async (req, res) => {
    try {
        const { uid } = req.user;
        const { rows } = await pool.query('SELECT * FROM addresses WHERE user_uid = $1 ORDER BY created_at DESC', [uid]);
        res.json(rows);
    } catch (err) {
        console.error("Error fetching addresses:", err);
        res.status(500).json({ success: false, message: 'Could not fetch addresses.' });
    }
});
app.post('/api/my-addresses', verifyToken, async (req, res) => {
    const { uid } = req.user;
    const { fullName, phoneNumber, street, locality, city, pincode, state, country } = req.body;
    if (!fullName || !phoneNumber || !street || !city || !pincode || !state || !country) {
        return res.status(400).json({ success: false, message: "All fields are required." });
    }
    try {
        const { rows } = await pool.query(
            `INSERT INTO addresses (user_uid, full_name, phone_number, street, locality, city, pincode, state, country)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [uid, fullName, phoneNumber, street, locality, city, pincode, state, country]
        );
        res.status(201).json({ success: true, message: "Address saved!", address: rows[0] });
    } catch (err) {
        console.error("Error saving address:", err);
        res.status(500).json({ success: false, message: 'Could not save address.' });
    }
});
app.delete('/api/my-addresses/:id', verifyToken, async (req, res) => {
    const { uid } = req.user;
    const { id } = req.params;
    try {
        const result = await pool.query('DELETE FROM addresses WHERE id = $1 AND user_uid = $2', [id, uid]);
        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: "Address not found or you don't have permission to delete it." });
        }
        res.status(200).json({ success: true, message: "Address deleted." });
    } catch (err) {
        console.error("Error deleting address:", err);
        res.status(500).json({ success: false, message: 'Could not delete address.' });
    }
});
app.get('/api/active-coupons', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT code, discount_type, discount_value FROM coupons WHERE is_active = TRUE');
        res.json(rows);
    } catch (err) {
        console.error("Error fetching active coupons:", err);
        res.status(500).json([]);
    }
});
app.get('/api/my-orders/:orderId/invoice', verifyToken, async (req, res) => {
    try {
        const { orderId } = req.params;
        const { uid } = req.user;

        const { rows } = await pool.query(
            'SELECT * FROM orders WHERE id = $1 AND user_uid = $2',
            [orderId, uid]
        );

        if (rows.length === 0) {
            return res.status(404).send('Order not found or you do not have permission to view it.');
        }

        const order = rows[0];
        
        generateInvoicePdf(order, (pdfData) => {
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="invoice-${order.id}.pdf"`);
            res.send(pdfData);
        });

    } catch (err) {
        console.error('Error generating invoice:', err);
        res.status(500).send('Error generating invoice.');
    }
});

// --- Admin Routes (Full code included) ---

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
            .add-form { margin-top: 2em; padding: 1.5em; border: 1px solid #ddd; background-color: white; }
            .logout-btn { background-color: #f44336; color: white; padding: 0.5em 1em; border: none; border-radius: 4px; cursor: pointer; text-decoration: none; }
            .form-group{margin-bottom:1em;} label{display:block;margin-bottom:0.5em;} input, select, textarea, button{padding:8px; width: 100%; box-sizing: border-box;}
            button, .button-style { padding: 8px; border: none; cursor: pointer; border-radius: 4px; }
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
            </div>
            <div>
                <a href="/admin/logout" class="logout-btn">Logout</a>
            </div>
        </nav>
        <div class="admin-container">
    `;
};

app.get('/admin/login', (req, res) => {
    res.send(`
        <!DOCTYPE html><html><head><title>Admin Login</title><style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;background-color:#f4f4f9;} .login-box{padding:2em;border:1px solid #ccc;background:white;box-shadow:0 4px 8px rgba(0,0,0,0.1);}.login-box h1{text-align:center;margin-top:0;}input{width:100%;padding:0.8em;margin-bottom:1em;box-sizing:border-box;}button{width:100%;padding:0.8em;background-color:#333;color:white;border:none;cursor:pointer;}</style></head>
        <body><div class="login-box"><h1>Admin Login</h1><form action="/admin/login" method="POST"><input type="password" name="password" placeholder="Password" required><button type="submit">Login</button></form></div></body></html>
    `);
});

app.post('/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === process.env.ADMIN_PASSWORD) {
        res.cookie('admin_session', process.env.ADMIN_SESSION_SECRET, { 
            httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 24 * 60 * 60 * 1000
        });
        res.redirect('/admin/dashboard');
    } else {
        res.status(401).send('Incorrect Password');
    }
});

app.get('/admin/logout', (req, res) => {
    res.clearCookie('admin_session');
    res.redirect('/admin/login');
});

app.get('/admin/dashboard', checkAdminAuth, (req, res) => {
    const header = getAdminHeaderHTML('Dashboard');
    res.send(`${header}<h1>Welcome to the Admin Dashboard</h1><p>Select a category from the navigation bar to get started.</p></div></body></html>`);
});

app.get('/admin/products', checkAdminAuth, async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM products ORDER BY id ASC');
        const productsHtml = rows.map(p => {
            const featuredStatus = p.is_featured ? '<strong>Yes</strong>' : 'No';
            const toggleButtonText = p.is_featured ? 'Remove Featured' : 'Make Featured';
            return `<tr>
                <td>${p.id}</td><td><img src="${p.image_url}" alt="${he.encode(p.name)}"></td><td>${he.encode(p.name)}</td>
                <td>${p.price}</td><td>${p.sale_price || 'N/A'}</td><td>${p.stock_quantity}</td><td>${he.encode(p.category || 'N/A')}</td><td>${featuredStatus}</td>
                <td>
                    <a href="/admin/edit-product/${p.id}">Edit</a>
                    <form action="/admin/delete-product/${p.id}" method="POST" style="display:inline; margin-left: 5px;"><button type="submit" onclick="return confirm('Are you sure?');">Delete</button></form>
                    <form action="/admin/toggle-featured/${p.id}" method="POST" style="display:inline; margin-left: 5px;"><button type="submit">${toggleButtonText}</button></form>
                </td>
            </tr>`;
        }).join('');
        const header = getAdminHeaderHTML('Manage Products');
        res.send(`${header}<h1>Manage Products</h1><table><thead><tr><th>ID</th><th>Image</th><th>Name</th><th>Price</th><th>Sale Price</th><th>Stock</th><th>Category</th><th>Featured?</th><th>Actions</th></tr></thead><tbody>${productsHtml}</tbody></table>
        <div class="add-form">
            <h2>Add New Product</h2>
            <form action="/admin/add-product" method="POST">
                <div class="form-group"><label>Name: <input name="productName" required></label></div>
                <div class="form-group"><label>Price: <input name="price" type="number" step="0.01" required></label></div>
                <div class="form-group"><label>Sale Price: <input name="salePrice" type="number" step="0.01"></label></div>
                <div class="form-group"><label>Stock: <input name="stockQuantity" type="number" value="10" required></label></div>
                <div class="form-group">
                    <label>Category: 
                        <select name="category" required>
                            <option value="">Select a Category</option>
                            <option value="premium-raw-makhana">Premium Raw Makhana</option>
                            <option value="premium-flavored-makhana">Premium Flavored Makhana</option>
                            <option value="nuts">Nuts</option>
                        </select>
                    </label>
                </div>
                <div class="form-group"><label>Description: <textarea name="description" required></textarea></label></div>
                <div class="form-group"><label>Image URL: <input name="imageUrl" required></label></div>
                <div class="form-group"><label><input type="checkbox" name="is_featured" value="true"> Mark as Featured</label></div>
                <button type="submit">Add Product</button>
            </form>
        </div></div></body></html>`);
    } catch (err) {
        res.status(500).send('Error loading product management page.');
    }
});

app.post('/admin/toggle-featured/:id', checkAdminAuth, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('UPDATE products SET is_featured = NOT is_featured WHERE id = $1', [id]);
        res.redirect(`/admin/products`);
    } catch (err) {
        console.error('Error toggling featured status:', err);
        res.status(500).send('Error updating product.');
    }
});

app.post('/admin/add-product', checkAdminAuth, async (req, res) => {
    const productSchema = Joi.object({
        productName: Joi.string().required(), price: Joi.number().required(),
        salePrice: Joi.number().allow(null, ''), stockQuantity: Joi.number().integer().required(),
        description: Joi.string().required(), imageUrl: Joi.string().uri().required(),
        is_featured: Joi.boolean(), category: Joi.string().required()
    });
    const isFeatured = req.body.is_featured === 'true';
    const { error, value } = productSchema.validate({ ...req.body, is_featured: isFeatured });
    if (error) { return res.status(400).send(error.details[0].message); }
    try {
        await pool.query('INSERT INTO products(name, price, sale_price, stock_quantity, description, image_url, is_featured, category) VALUES($1, $2, $3, $4, $5, $6, $7, $8)',
            [value.productName, value.price, value.salePrice || null, value.stockQuantity, value.description, value.imageUrl, value.is_featured, value.category]);
        res.redirect(`/admin/products`);
    } catch (err) { res.status(500).send('Error adding product.'); }
});

app.get('/admin/edit-product/:id', checkAdminAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
        if (rows.length === 0) { return res.status(404).send('Product not found.'); }
        const p = rows[0];
        const isChecked = p.is_featured ? 'checked' : '';
        
        const categories = {
            "premium-raw-makhana": "Premium Raw Makhana",
            "premium-flavored-makhana": "Premium Flavored Makhana",
            "nuts": "Nuts"
        };
        let categoryOptions = '<option value="">Select a Category</option>';
        for (const [value, text] of Object.entries(categories)) {
            const selected = p.category === value ? 'selected' : '';
            categoryOptions += `<option value="${value}" ${selected}>${text}</option>`;
        }
        
        const header = getAdminHeaderHTML(`Edit: ${he.encode(p.name)}`);
        res.send(`${header}<h1>Edit: ${he.encode(p.name)}</h1>
        <form action="/admin/update-product/${p.id}" method="POST">
            <div class="form-group"><label>Name: <input name="productName" value="${he.encode(p.name)}" required></label></div>
            <div class="form-group"><label>Price: <input name="price" type="number" step="0.01" value="${p.price}" required></label></div>
            <div class="form-group"><label>Sale Price: <input name="salePrice" type="number" step="0.01" value="${p.sale_price || ''}"></label></div>
            <div class="form-group"><label>Stock: <input name="stockQuantity" type="number" value="${p.stock_quantity}" required></label></div>
            <div class="form-group"><label>Category: <select name="category" required>${categoryOptions}</select></label></div>
            <div class="form-group"><label>Description: <textarea name="description" required>${he.encode(p.description)}</textarea></label></div>
            <div class="form-group"><label>Image URL: <input name="imageUrl" value="${p.image_url}" required></label></div>
            <div class="form-group"><label><input type="checkbox" name="is_featured" value="true" ${isChecked}> Mark as Featured</label></div>
            <button type="submit">Update</button>
        </form></div></body></html>`);
    } catch (err) { res.status(500).send('Error loading edit page.'); }
});

app.post('/admin/update-product/:id', checkAdminAuth, async (req, res) => {
    const { id } = req.params;
    const productSchema = Joi.object({
        productName: Joi.string().required(), price: Joi.number().required(),
        salePrice: Joi.number().allow(null, ''), stockQuantity: Joi.number().integer().required(),
        description: Joi.string().required(), imageUrl: Joi.string().uri().required(),
        is_featured: Joi.boolean(), category: Joi.string().required()
    });
    const isFeatured = req.body.is_featured === 'true';
    const { error, value } = productSchema.validate({ ...req.body, is_featured: isFeatured });
    if (error) { return res.status(400).send(error.details[0].message); }
    try {
        await pool.query('UPDATE products SET name = $1, price = $2, description = $3, image_url = $4, sale_price = $5, stock_quantity = $6, is_featured = $7, category = $8 WHERE id = $9',
            [value.productName, value.price, value.description, value.imageUrl, value.salePrice || null, value.stockQuantity, value.is_featured, value.category, id]);
        res.redirect(`/admin/products`);
    } catch (err) { res.status(500).send('Error updating product.'); }
});


app.post('/admin/delete-product/:id', checkAdminAuth, async (req, res) => {
    try {
        await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
        res.redirect(`/admin/products`);
    } catch (err) { res.status(500).send('Error deleting product.'); }
});

app.get('/admin/users', checkAdminAuth, async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT email, firebase_uid, phone, created_at, deleted_at FROM users ORDER BY created_at DESC');
        const usersHtml = rows.map(user => {
            const status = user.deleted_at ? `<span style="color:red;">Deleted on ${new Date(user.deleted_at).toLocaleDateString()}</span>` : '<span style="color:green;">Active</span>';
            
            let actionsHtml = '';
            if (!user.deleted_at) {
                actionsHtml += `<form action="/admin/soft-delete-user/${user.firebase_uid}" method="POST" style="display:inline-block; margin-right: 5px;">
                                    <button type="submit" class="soft-delete-btn" onclick="return confirm('Are you sure you want to soft delete this user? They will be marked as inactive.');">Soft Delete</button>
                                </form>`;
            }
            actionsHtml += `<form action="/admin/permanent-delete-user/${user.firebase_uid}" method="POST" style="display:inline-block;">
                                <button type="submit" class="permanent-delete-btn" onclick="return confirm('WARNING: This will permanently delete the user from Firebase and your database. This action is irreversible. Are you sure?');">Permanent Delete</button>
                            </form>`;

            return `<tr>
                        <td>${he.encode(user.email)}</td>
                        <td>${he.encode(user.phone || 'N/A')}</td>
                        <td>${status}</td>
                        <td>${actionsHtml}</td>
                    </tr>`;
        }).join('');
        const header = getAdminHeaderHTML('Manage Users');
        res.send(`${header}<h1>Registered Users</h1>
                    <table>
                        <thead><tr><th>Email</th><th>Phone</th><th>Status</th><th>Actions</th></tr></thead>
                        <tbody>${usersHtml}</tbody>
                    </table>
                  </div></body></html>`);
    } catch (err) {
        console.error("Error loading users page:", err);
        res.status(500).send('Error loading users page.');
    }
});

app.post('/admin/soft-delete-user/:uid', checkAdminAuth, async (req, res) => {
    try {
        const { uid } = req.params;
        await pool.query('UPDATE users SET deleted_at = NOW() WHERE firebase_uid = $1', [uid]);
        console.log(`Admin soft-deleted user ${uid}`);
        res.redirect('/admin/users');
    } catch (err) {
        console.error("Error soft-deleting user:", err);
        res.status(500).send('Error soft-deleting user.');
    }
});

app.post('/admin/permanent-delete-user/:uid', checkAdminAuth, async (req, res) => {
    try {
        const { uid } = req.params;
        await admin.auth().deleteUser(uid);
        console.log(`Admin permanently deleted user ${uid} from Firebase Auth.`);
        await pool.query('DELETE FROM users WHERE firebase_uid = $1', [uid]);
        console.log(`Admin permanently deleted user ${uid} from database.`);
        res.redirect('/admin/users');
    } catch (err) {
        console.error("Error permanently deleting user:", err);
        if (err.code === 'auth/user-not-found') {
            try {
                const { uid } = req.params;
                await pool.query('DELETE FROM users WHERE firebase_uid = $1', [uid]);
                console.log(`Admin deleted orphaned user ${uid} from database.`);
                return res.redirect('/admin/users');
            } catch (dbErr) {
                 return res.status(500).send('Error permanently deleting user from database.');
            }
        }
        res.status(500).send('Error permanently deleting user.');
    }
});

app.get('/admin/orders', checkAdminAuth, async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
        let orderRowsHtml = rows.map(order => {
            let itemsHtml = '<ul>' + Object.keys(order.cart_items).map(key => `<li>${he.encode(key)} (x${order.cart_items[key].quantity})</li>`).join('') + '</ul>';
            const statuses = ['Processing', 'Shipped', 'Delivered', 'Cancelled'];
            const statusOptions = statuses.map(s => `<option value="${s}" ${order.status === s ? 'selected' : ''}>${s}</option>`).join('');
            
            const actionsHtml = `<form action="/admin/delete-order/${order.id}" method="POST" style="margin-top: 5px;">
                                    <button type="submit" class="permanent-delete-btn" onclick="return confirm('Are you sure you want to permanently delete this order record?');">Delete Order</button>
                                 </form>`;

            return `
                <tr>
                    <td>${order.id}</td>
                    <td>${he.encode(order.customer_name)}<br>${he.encode(order.phone_number)}</td>
                    <td>${he.encode(order.address)}</td>
                    <td>₹${order.order_amount}</td>
                    <td><form action="/admin/update-order-status/${order.id}" method="POST"><select name="newStatus">${statusOptions}</select><button type="submit">Update</button></form></td>
                    <td>${he.encode(order.razorpay_payment_id)}</td>
                    <td>${new Date(order.created_at).toLocaleString()}</td>
                    <td>${itemsHtml}</td>
                    <td>${actionsHtml}</td>
                </tr>`;
        }).join('');
        const header = getAdminHeaderHTML('Manage Orders');
        res.send(`${header}<h1>All Orders</h1>
                    <table>
                        <thead><tr><th>ID</th><th>Customer</th><th>Address</th><th>Amount</th><th>Status</th><th>Payment ID</th><th>Date</th><th>Items</th><th>Actions</th></tr></thead>
                        <tbody>${orderRowsHtml}</tbody>
                    </table>
                  </div></body></html>`);
    } catch (err) {
        console.error("Error loading orders page:", err);
        res.status(500).send('Internal Server Error');
    }
});

// START: MODIFIED ROUTE FOR ORDER STATUS UPDATE
app.post('/admin/update-order-status/:id', checkAdminAuth, async (req, res) => {
    const { id } = req.params;
    const { newStatus } = req.body;
    try {
        // Get all the necessary info in one query
        const { rows } = await pool.query(
            'SELECT o.status, o.customer_name, u.email FROM orders o JOIN users u ON o.user_uid = u.firebase_uid WHERE o.id = $1', 
            [id]
        );

        if (rows.length > 0) {
            const orderInfo = rows[0];
            const previousStatus = orderInfo.status;
            const customerEmail = orderInfo.email;
            const customerName = orderInfo.customer_name;

            // Only send an email if the status has actually changed
            if (newStatus !== previousStatus) {
                if (newStatus === 'Shipped') {
                    await sendOrderShippedEmail(customerEmail, customerName, id);
                } else if (newStatus === 'Delivered') {
                    await sendOrderDeliveredEmail(customerEmail, customerName, id);
                } else if (newStatus === 'Cancelled') {
                    await sendOrderCancellationEmail(customerEmail, customerName, id);
                }
            }
        }

        // Update the status in the database
        await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [newStatus, id]);
        res.redirect('/admin/orders');
    } catch (err) {
        console.error("Error updating order status:", err);
        res.status(500).send('Error updating order status.');
    }
});
// END: MODIFIED ROUTE

app.post('/admin/delete-order/:id', checkAdminAuth, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM orders WHERE id = $1', [id]);
        console.log(`Admin deleted order ${id}`);
        res.redirect('/admin/orders');
    } catch (err) {
        console.error("Error deleting order:", err);
        res.status(500).send('Error deleting order.');
    }
});

app.get('/admin/coupons', checkAdminAuth, async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM coupons ORDER BY created_at DESC');
        const couponsHtml = rows.map(c => `<tr>
            <td>${c.id}</td><td>${he.encode(c.code)}</td><td>${c.discount_type}</td>
            <td>${c.discount_value}</td><td>${c.is_active ? 'Yes' : 'No'}</td>
            <td><form action="/admin/delete-coupon/${c.id}" method="POST" style="display:inline;"><button type="submit" onclick="return confirm('Are you sure?');">Delete</button></form></td>
        </tr>`).join('');
        
        const header = getAdminHeaderHTML('Manage Coupons');
        res.send(`
            ${header}<h1>Manage Coupons</h1>
            <table><thead><tr><th>ID</th><th>Code</th><th>Type</th><th>Value</th><th>Active?</th><th>Actions</th></tr></thead>
            <tbody>${couponsHtml}</tbody></table>
            <div class="add-form">
                <h2>Add New Coupon</h2>
                <form action="/admin/add-coupon" method="POST">
                    <div class="form-group"><label>Coupon Code: <input name="code" required></label></div>
                    <div class="form-group">
                        <label>Discount Type: 
                            <select name="discount_type"><option value="percentage">Percentage</option><option value="fixed">Fixed Amount</option></select>
                        </label>
                    </div>
                    <div class="form-group"><label>Discount Value: <input name="discount_value" type="number" step="0.01" required></label></div>
                    <button type="submit">Add Coupon</button>
                </form>
            </div>
            </div></body></html>
        `);
    } catch (err) {
        res.status(500).send('Error loading coupon management page.');
    }
});

app.post('/admin/add-coupon', checkAdminAuth, async (req, res) => {
    const { code, discount_type, discount_value } = req.body;
    try {
        await pool.query('INSERT INTO coupons(code, discount_type, discount_value) VALUES($1, $2, $3)', [code.toUpperCase(), discount_type, discount_value]);
        res.redirect('/admin/coupons');
    } catch (err) {
        res.status(500).send('Error adding coupon.');
    }
});

app.post('/admin/delete-coupon/:id', checkAdminAuth, async (req, res) => {
    try {
        await pool.query('DELETE FROM coupons WHERE id = $1', [req.params.id]);
        res.redirect('/admin/coupons');
    } catch (err) {
        res.status(500).send('Error deleting coupon.');
    }
});

app.get('/admin/reviews', checkAdminAuth, async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT r.id, r.product_name, r.rating, r.review_text, r.reviewer_name, r.user_uid, u.email FROM reviews r JOIN users u ON r.user_uid = u.firebase_uid ORDER BY r.created_at DESC');
        const reviewsHtml = rows.map(r => `<tr>
            <td>${r.id}</td><td>${he.encode(r.product_name)}</td>
            <td>${he.encode(r.reviewer_name)}<br>(${he.encode(r.email)})</td>
            <td>${'⭐'.repeat(r.rating)}</td><td>${he.encode(r.review_text || '')}</td>
            <td>
                <form action="/admin/delete-review/${r.id}" method="POST" style="display:inline-block; margin-bottom: 5px;"><button type="submit" onclick="return confirm('Delete review?');">Delete Review</button></form>
                <form action="/admin/block-user/${r.user_uid}" method="POST" style="display:inline-block;"><button type="submit" onclick="return confirm('Block this user from leaving reviews?');">Block User</button></form>
            </td>
        </tr>`).join('');

        const header = getAdminHeaderHTML('Manage Reviews');
        res.send(`
            ${header}<h1>Manage Reviews</h1>
            <table><thead><tr><th>ID</th><th>Product</th><th>Reviewer</th><th>Rating</th><th>Review Text</th><th>Actions</th></tr></thead>
            <tbody>${reviewsHtml}</tbody></table>
            </div></body></html>
        `);
    } catch (err) {
        res.status(500).send('Error loading reviews management page.');
    }
});

app.post('/admin/delete-review/:id', checkAdminAuth, async (req, res) => {
    try {
        await pool.query('DELETE FROM reviews WHERE id = $1', [req.params.id]);
        res.redirect('/admin/reviews');
    } catch (err) {
        res.status(500).send('Error deleting review.');
    }
});

app.post('/admin/block-user/:uid', checkAdminAuth, async (req, res) => {
    try {
        await pool.query('UPDATE users SET is_blocked_from_reviewing = TRUE WHERE firebase_uid = $1', [req.params.uid]);
        res.redirect('/admin/reviews');
    } catch (err) {
        res.status(500).send('Error blocking user.');
    }
});


app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something broke!');
});

app.listen(port, () => {
    console.log(`Server is listening on port ${port}`);
    setupDatabase();
});
