// --- FINAL server.js WITH SAVED ADDRESSES FEATURE ---

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

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 150, // Increased slightly for more API calls
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
                id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, price NUMERIC(10, 2) NOT NULL, description TEXT,
                image_url VARCHAR(2048), created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                sale_price NUMERIC(10, 2), stock_quantity INTEGER NOT NULL DEFAULT 10
            );
        `);
        console.log('INFO: "products" table is ready.');
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

        // --- NEW ADDRESSES TABLE ---
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
        console.error('Error setting up database tables:', err);
    } finally {
        client.release();
    }
}
// ... The rest of the file is included below ...
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
async function sendOrderConfirmationEmail(customerEmail, customerName, order, cart, subtotal, shippingCost, total, discount = 0) {
    const orderDate = new Date(order.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const itemsHtml = Object.keys(cart).map(name => {
        const item = cart[name];
        const displayName = name.charAt(0).toUpperCase() + name.slice(1);
        return `<tr><td style="padding: 10px; border-bottom: 1px solid #ddd;">${displayName} (x${item.quantity})</td><td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right;">₹${(item.price * item.quantity).toFixed(2)}</td></tr>`;
    }).join('');
    
    const discountHtml = discount > 0 ? `<tr><td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right; color: green;">Discount:</td><td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right; color: green;">- ₹${discount.toFixed(2)}</td></tr>` : '';
    
    const emailHtml = `
      <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #ddd; padding: 20px;">
        <h1 style="color: #F97316; text-align: center;">Thank You For Your Order!</h1><p>Hi ${he.encode(customerName)},</p><p>We've received your order and will process it shortly. Here are the details:</p>
        <div style="border: 1px solid #eee; padding: 15px; margin: 20px 0;"><h2 style="margin-top: 0;">Invoice #${order.id}</h2><p><strong>Order Date:</strong> ${orderDate}</p>
          <table style="width: 100%; border-collapse: collapse;">
            <thead><tr><th style="padding: 10px; border-bottom: 2px solid #ddd; text-align: left;">Item</th><th style="padding: 10px; border-bottom: 2px solid #ddd; text-align: right;">Price</th></tr></thead>
            <tbody>${itemsHtml}<tr><td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right;">Subtotal:</td><td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right;">₹${subtotal.toFixed(2)}</td></tr>${discountHtml}<tr><td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right;">Shipping:</td><td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right;">₹${shippingCost.toFixed(2)}</td></tr><tr><td style="padding: 10px; font-weight: bold; text-align: right;">Total:</td><td style="padding: 10px; font-weight: bold; text-align: right;">₹${total.toFixed(2)}</td></tr></tbody>
          </table>
        </div><p style="font-size: 12px; color: #777; text-align: center;">This is an automated mail, please do not reply. For any questions, contact us at <a href="mailto:thebiharimakhana@gmail.com">thebiharimakhana@gmail.com</a>.</p>
      </div>`;
    const msg = { to: customerEmail, from: 'thebiharimakhana@gmail.com', subject: `Your The Bihari Makhana Order #${order.id} is Confirmed!`, html: emailHtml };
    try {
        await sgMail.send(msg);
        console.log('Confirmation email sent to', customerEmail);
    } catch (error) {
        console.error('Error sending confirmation email:', error);
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
        const { search, sort } = req.query;
        let query = 'SELECT * FROM products WHERE stock_quantity > 0';
        const queryParams = [];
        if (search) {
            query += ` AND (name ILIKE $${queryParams.length + 1} OR description ILIKE $${queryParams.length + 1})`;
            queryParams.push(`%${search}%`);
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
        res.status(500).send('Error fetching products');
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
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, created_at
        `;
        const values = [
            addressDetails.name, addressDetails.phone, addressDetails.address, 
            JSON.stringify(cart), totalAmount, user.uid, paymentId,
            appliedCouponCode, discount
        ];
        const orderResult = await pool.query(query, values);
        const newOrder = orderResult.rows[0];
        await sendOrderConfirmationEmail(user.email, addressDetails.name, newOrder, cart, subtotal, shippingCost, totalAmount, discount);
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
    const { uid } = req.user;
    const { productName, rating, reviewText } = req.body;
    if (!productName || !rating) {
        return res.status(400).json({ success: false, message: 'Product and rating are required.' });
    }
    try {
        const userResult = await pool.query('SELECT is_blocked_from_reviewing, name FROM users WHERE firebase_uid = $1', [uid]);
        if (userResult.rows.length > 0 && userResult.rows[0].is_blocked_from_reviewing) {
            return res.status(403).json({ success: false, message: 'You are not permitted to leave reviews.' });
        }
        const reviewerName = userResult.rows[0]?.name || req.user.name;
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

// --- NEW ADDRESS API ENDPOINTS ---
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
    // Simple validation
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


// --- Admin Routes ---
app.get('/admin/products', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) { return res.status(403).send('Access Denied'); }
    try {
        const { rows } = await pool.query('SELECT * FROM products ORDER BY id ASC');
        const productsHtml = rows.map(p => `<tr><td>${p.id}</td><td><img src="${p.image_url}" alt="${he.encode(p.name)}" width="50"></td><td>${he.encode(p.name)}</td><td>${p.price}</td><td>${p.sale_price || 'N/A'}</td><td>${p.stock_quantity}</td><td><a href="/admin/edit-product/${p.id}?password=${encodeURIComponent(password)}">Edit</a><form action="/admin/delete-product/${p.id}?password=${encodeURIComponent(password)}" method="POST" style="display:inline;"><button type="submit" onclick="return confirm('Are you sure?');">Delete</button></form></td></tr>`).join('');
        res.send(`<!DOCTYPE html><html><head><title>Manage Products</title><style>body{font-family:sans-serif;margin:2em}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px}img{max-width:50px}.add-form{margin-top:2em;padding:1em;border:1px solid #ddd}</style></head><body><h1>Manage Products</h1><a href="/view-orders?password=${encodeURIComponent(password)}">View Orders</a><br><a href="/admin/coupons?password=${encodeURIComponent(password)}">Manage Coupons</a><br><a href="/admin/reviews?password=${encodeURIComponent(password)}">Manage Reviews</a><br><br><table><thead><tr><th>ID</th><th>Image</th><th>Name</th><th>Price</th><th>Sale Price</th><th>Stock</th><th>Actions</th></tr></thead><tbody>${productsHtml}</tbody></table><div class="add-form"><h2>Add New Product</h2><form action="/add-product?password=${encodeURIComponent(password)}" method="POST"><p><label>Name: <input name="productName" required></label></p><p><label>Price: <input name="price" type="number" step="0.01" required></label></p><p><label>Sale Price: <input name="salePrice" type="number" step="0.01"></label></p><p><label>Stock: <input name="stockQuantity" type="number" value="10" required></label></p><p><label>Description: <textarea name="description" required></textarea></label></p><p><label>Image URL: <input name="imageUrl" required></label></p><button type="submit">Add Product</button></form></div></body></html>`);
    } catch (err) {
        res.status(500).send('Error loading product management page.');
    }
});
app.post('/add-product', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) { return res.status(403).send('Access Denied'); }
    const productSchema = Joi.object({
        productName: Joi.string().required(),
        price: Joi.number().required(),
        salePrice: Joi.number().allow(null, ''),
        stockQuantity: Joi.number().integer().required(),
        description: Joi.string().required(),
        imageUrl: Joi.string().uri().required()
    });
    const { error, value } = productSchema.validate(req.body);
    if (error) { return res.status(400).send(error.details[0].message); }
    try {
        await pool.query(
            'INSERT INTO products(name, price, sale_price, stock_quantity, description, image_url) VALUES($1, $2, $3, $4, $5, $6)',
            [value.productName, value.price, value.salePrice || null, value.stockQuantity, value.description, value.imageUrl]
        );
        res.redirect(`/admin/products?password=${encodeURIComponent(password)}`);
    } catch (err) {
        res.status(500).send('Error adding product.');
    }
});
app.get('/admin/edit-product/:id', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) { return res.status(403).send('Access Denied'); }
    try {
        const { id } = req.params;
        const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
        if (rows.length === 0) { return res.status(404).send('Product not found.'); }
        const p = rows[0];
        res.send(`<!DOCTYPE html><html><head><title>Edit Product</title><style>body{font-family:sans-serif;margin:2em}label,input,textarea{display:block;width:300px;margin-bottom:1em}</style></head><body><h1>Edit: ${he.encode(p.name)}</h1><form action="/admin/update-product/${p.id}?password=${encodeURIComponent(password)}" method="POST"><p><label>Name: <input name="productName" value="${he.encode(p.name)}" required></label></p><p><label>Price: <input name="price" type="number" step="0.01" value="${p.price}" required></label></p><p><label>Sale Price: <input name="salePrice" type="number" step="0.01" value="${p.sale_price || ''}"></label></p><p><label>Stock: <input name="stockQuantity" type="number" value="${p.stock_quantity}" required></label></p><p><label>Description: <textarea name="description" required>${he.encode(p.description)}</textarea></label></p><p><label>Image URL: <input name="imageUrl" value="${p.image_url}" required></label></p><button type="submit">Update</button></form></body></html>`);
    } catch (err) {
        res.status(500).send('Error loading edit page.');
    }
});
app.post('/admin/update-product/:id', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) { return res.status(403).send('Access Denied'); }
    const { id } = req.params;
    const productSchema = Joi.object({
        productName: Joi.string().required(),
        price: Joi.number().required(),
        salePrice: Joi.number().allow(null, ''),
        stockQuantity: Joi.number().integer().required(),
        description: Joi.string().required(),
        imageUrl: Joi.string().uri().required()
    });
    const { error, value } = productSchema.validate(req.body);
    if (error) { return res.status(400).send(error.details[0].message); }
    try {
        await pool.query(
            'UPDATE products SET name = $1, price = $2, description = $3, image_url = $4, sale_price = $5, stock_quantity = $6 WHERE id = $7',
            [value.productName, value.price, value.description, value.imageUrl, value.salePrice || null, value.stockQuantity, id]
        );
        res.redirect(`/admin/products?password=${encodeURIComponent(password)}`);
    } catch (err) {
        res.status(500).send('Error updating product.');
    }
});
app.post('/admin/delete-product/:id', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) { return res.status(403).send('Access Denied'); }
    try {
        await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
        res.redirect(`/admin/products?password=${encodeURIComponent(password)}`);
    } catch (err) {
        res.status(500).send('Error deleting product.');
    }
});
app.get('/admin/users', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) { return res.status(403).send('Access Denied'); }
    try {
        const { rows } = await pool.query('SELECT email, firebase_uid, phone, created_at, deleted_at, is_blocked_from_reviewing FROM users ORDER BY created_at DESC');
        const usersHtml = rows.map(user => {
            const status = user.deleted_at 
                ? `<span style="color:red;">Deleted on ${new Date(user.deleted_at).toLocaleDateString()}</span>` 
                : '<span style="color:green;">Active</span>';
            
            let actionButton = user.deleted_at
                ? `<form action="/admin/hard-delete-user/${user.firebase_uid}?password=${encodeURIComponent(password)}" method="POST" style="display:inline;">
                        <button type="submit" onclick="return confirm('PERMANENT ACTION: Are you sure you want to permanently erase this user\\'s history? This cannot be undone.');" style="color:red; background:none; border:none; padding:0; cursor:pointer; font-weight:bold; text-decoration:underline;">Permanently Delete</button>
                    </form>`
                : `<form action="/admin/delete-user/${user.firebase_uid}?password=${encodeURIComponent(password)}" method="POST" style="display:inline;">
                        <button type="submit" onclick="return confirm('Are you sure you want to delete this user? They will not be able to log in again.');" style="color:orange; background:none; border:none; padding:0; cursor:pointer; text-decoration:underline;">Delete (Deactivate)</button>
                    </form>`;

            if(!user.deleted_at){
                actionButton += `<br>` + (user.is_blocked_from_reviewing
                    ? `<form action="/admin/unblock-user/${user.firebase_uid}?password=${encodeURIComponent(password)}" method="POST" style="display:inline;">
                            <button type="submit" style="color:green; background:none; border:none; padding:0; cursor:pointer; text-decoration:underline;">Unblock Reviews</button>
                        </form>`
                    : `<form action="/admin/block-user/${user.firebase_uid}?password=${encodeURIComponent(password)}" method="POST" style="display:inline;">
                            <button type="submit" style="color:purple; background:none; border:none; padding:0; cursor:pointer; text-decoration:underline;">Block Reviews</button>
                        </form>`
                );
            }

            return `<tr>
                <td>${he.encode(user.email)}</td>
                <td>${he.encode(user.phone || 'N/A')}</td> 
                <td>${status}</td>
                <td>${new Date(user.created_at).toLocaleString()}</td>
                <td>${user.is_blocked_from_reviewing ? '<span style="color:purple;">Reviewing Blocked</span>' : 'Can Review'}</td>
                <td>${actionButton}</td>
            </tr>`
        }).join('');
        res.send(`<!DOCTYPE html><html><head><title>View Users</title><style>body{font-family:sans-serif;margin:2em}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px}th{background-color:#f2f2f2}</style></head><body><h1>Registered Users</h1><table><thead><tr><th>Email</th><th>Phone</th><th>Status</th><th>Registration Date</th><th>Review Status</th><th>Actions</th></tr></thead><tbody>${usersHtml}</tbody></table></body></html>`);
    } catch (err) {
        console.error("Error loading users page:", err);
        res.status(500).send('Error loading users page.');
    }
});
app.post('/admin/delete-user/:uid', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) { return res.status(403).send('Access Denied'); }
    const { uid } = req.params;
    try {
        await pool.query('UPDATE users SET deleted_at = NOW() WHERE firebase_uid = $1', [uid]);
        await admin.auth().deleteUser(uid);
        console.log(`ADMIN ACTION: Successfully soft-deleted user ${uid}`);
        res.redirect(`/admin/users?password=${encodeURIComponent(password)}`);
    } catch (err) {
        console.error(`ADMIN ACTION: Failed to delete user ${uid}:`, err);
        res.status(500).send(`Error deleting user. <a href="/admin/users?password=${encodeURIComponent(password)}">Go back</a>`);
    }
});
app.post('/admin/hard-delete-user/:uid', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) { return res.status(403).send('Access Denied'); }
    const { uid } = req.params;
    try {
        await pool.query('DELETE FROM users WHERE firebase_uid = $1', [uid]);
        console.log(`ADMIN ACTION: Successfully PERMANENTLY deleted user record ${uid}`);
        res.redirect(`/admin/users?password=${encodeURIComponent(password)}`);
    } catch (err) {
        console.error(`ADMIN ACTION: Failed to permanently delete user ${uid}:`, err);
        res.status(500).send(`Error permanently deleting user. <a href="/admin/users?password=${encodeURIComponent(password)}">Go back</a>`);
    }
});
app.get('/view-orders', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) { return res.status(403).send('Access Denied'); }
    try {
        const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
        let html = `<h1>All Orders</h1><a href="/admin/coupons?password=${encodeURIComponent(password)}">Manage Coupons</a><br><a href="/admin/products?password=${encodeURIComponent(password)}">Manage Products</a><br><a href="/admin/reviews?password=${encodeURIComponent(password)}">Manage Reviews</a><br><br><table border="1" style="width:100%; border-collapse: collapse;"><thead><tr><th>ID</th><th>Customer</th><th>Address</th><th>Amount</th><th>Status</th><th>Payment ID</th><th>Date</th><th>Items</th><th>Actions</th></tr></thead><tbody>`;
        rows.forEach(order => {
            let itemsHtml = 'N/A';
            if (order.cart_items) {
                try {
                    const items = (typeof order.cart_items === 'string') ? JSON.parse(order.cart_items) : order.cart_items;
                    itemsHtml = '<ul>' + Object.keys(items).map(key => `<li>${he.encode(key)} (x${items[key].quantity})</li>`).join('') + '</ul>';
                } catch (e) { itemsHtml = '<span style="color:red;">Invalid data</span>'; }
            }
            const statuses = ['Processing', 'Shipped', 'Delivered', 'Cancelled'];
            const statusOptions = statuses.map(s => `<option value="${s}" ${order.status === s ? 'selected' : ''}>${s}</option>`).join('');
            html += `
                <tr>
                    <td>${order.id}</td>
                    <td>${he.encode(order.customer_name)}<br>${he.encode(order.phone_number)}</td>
                    <td>${he.encode(order.address)}</td>
                    <td>₹${order.order_amount}</td>
                    <td>
                        <form action="/admin/update-order-status/${order.id}?password=${encodeURIComponent(password)}" method="POST">
                            <select name="newStatus">${statusOptions}</select>
                            <button type="submit" style="margin-top:5px;">Update</button>
                        </form>
                    </td>
                    <td>${he.encode(order.razorpay_payment_id)}</td>
                    <td>${new Date(order.created_at).toLocaleString()}</td>
                    <td>${itemsHtml}</td>
                    <td>
                        <form action="/admin/delete-order/${order.id}?password=${encodeURIComponent(password)}" method="POST" style="display:inline-block;">
                            <button type="submit" onclick="return confirm('Permanently DELETE this order? This cannot be undone.');" style="color:red;">Delete</button>
                        </form>
                    </td>
                </tr>
            `;
        });
        html += '</tbody></table>';
        res.send(html);
    } catch (err) {
        console.error("Error loading orders page:", err);
        res.status(500).send('Internal Server Error');
    }
});
app.post('/admin/update-order-status/:id', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) { return res.status(403).send('Access Denied'); }
    const { id } = req.params;
    const { newStatus } = req.body;
    try {
        const orderCheck = await pool.query('SELECT status, user_uid, customer_name FROM orders WHERE id = $1', [id]);
        if (orderCheck.rows.length === 0) {
            return res.status(404).send("Order not found.");
        }
        const oldStatus = orderCheck.rows[0].status;
        await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [newStatus, id]);
        if (newStatus === 'Shipped' && oldStatus !== 'Shipped') {
            const order = orderCheck.rows[0];
            const userResult = await pool.query('SELECT email FROM users WHERE firebase_uid = $1', [order.user_uid]);
            if (userResult.rows.length > 0) {
                const customerEmail = userResult.rows[0].email;
                await sendOrderShippedEmail(customerEmail, order.customer_name, id);
            }
        }
        res.redirect(`/view-orders?password=${encodeURIComponent(password)}`);
    } catch (err) {
        console.error(`Error updating status for order ${id}:`, err);
        res.status(500).send('Error updating order status.');
    }
});
app.post('/admin/delete-order/:id', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) { return res.status(403).send('Access Denied'); }
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM orders WHERE id = $1', [id]);
        res.redirect(`/view-orders?password=${encodeURIComponent(password)}`);
    } catch (err) {
        res.status(500).send('Error deleting order.');
    }
});
app.get('/admin/coupons', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) { return res.status(403).send('Access Denied'); }
    try {
        const { rows } = await pool.query('SELECT * FROM coupons ORDER BY created_at DESC');
        const couponsHtml = rows.map(c => `<tr>
            <td>${c.id}</td>
            <td>${he.encode(c.code)}</td>
            <td>${c.discount_type}</td>
            <td>${c.discount_value}</td>
            <td>${c.is_active ? 'Yes' : 'No'}</td>
            <td>
                <form action="/admin/delete-coupon/${c.id}?password=${encodeURIComponent(password)}" method="POST" style="display:inline;">
                    <button type="submit" onclick="return confirm('Are you sure?');">Delete</button>
                </form>
            </td>
        </tr>`).join('');
        
        res.send(`
            <!DOCTYPE html><html><head><title>Manage Coupons</title>
            <style>
                body{font-family:sans-serif;margin:2em}
                table{border-collapse:collapse;width:100%; margin-bottom: 2em;}
                th,td{border:1px solid #ddd;padding:8px}
                .add-form{padding:1.5em;border:1px solid #ddd; background-color:#f9f9f9;}
                .form-group{margin-bottom:1em;}
                label{display:block;margin-bottom:0.5em;}
                input, select{padding:8px;width:250px;}
            </style>
            </head><body>
            <h1>Manage Coupons</h1>
            <a href="/view-orders?password=${encodeURIComponent(password)}">Back to Orders</a>
            <table><thead><tr><th>ID</th><th>Code</th><th>Type</th><th>Value</th><th>Active?</th><th>Actions</th></tr></thead>
            <tbody>${couponsHtml}</tbody></table>
            <div class="add-form">
                <h2>Add New Coupon</h2>
                <form action="/admin/add-coupon?password=${encodeURIComponent(password)}" method="POST">
                    <div class="form-group">
                        <label>Coupon Code (e.g., MAKHANA10): <input name="code" required></label>
                    </div>
                    <div class="form-group">
                        <label>Discount Type: 
                            <select name="discount_type">
                                <option value="percentage">Percentage</option>
                                <option value="fixed">Fixed Amount</option>
                            </select>
                        </label>
                    </div>
                    <div class="form-group">
                        <label>Discount Value (e.g., 10 for 10% or 100 for ₹100): <input name="discount_value" type="number" step="0.01" required></label>
                    </div>
                    <button type="submit">Add Coupon</button>
                </form>
            </div>
            </body></html>
        `);
    } catch (err) {
        res.status(500).send('Error loading coupon management page.');
    }
});
app.post('/admin/add-coupon', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) { return res.status(403).send('Access Denied'); }
    const { code, discount_type, discount_value } = req.body;
    try {
        await pool.query(
            'INSERT INTO coupons(code, discount_type, discount_value) VALUES($1, $2, $3)',
            [code.toUpperCase(), discount_type, discount_value]
        );
        res.redirect(`/admin/coupons?password=${encodeURIComponent(password)}`);
    } catch (err) {
        console.error("Error adding coupon:", err);
        res.status(500).send('Error adding coupon. Is the code already in use?');
    }
});
app.post('/admin/delete-coupon/:id', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) { return res.status(403).send('Access Denied'); }
    try {
        await pool.query('DELETE FROM coupons WHERE id = $1', [req.params.id]);
        res.redirect(`/admin/coupons?password=${encodeURIComponent(password)}`);
    } catch (err) {
        res.status(500).send('Error deleting coupon.');
    }
});
app.post('/admin/block-user/:uid', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) { return res.status(403).send('Access Denied'); }
    try {
        await pool.query('UPDATE users SET is_blocked_from_reviewing = TRUE WHERE firebase_uid = $1', [req.params.uid]);
        res.redirect(`/admin/reviews?password=${encodeURIComponent(password)}`);
    } catch (err) {
        res.status(500).send('Error blocking user.');
    }
});
app.post('/admin/unblock-user/:uid', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) { return res.status(403).send('Access Denied'); }
    try {
        await pool.query('UPDATE users SET is_blocked_from_reviewing = FALSE WHERE firebase_uid = $1', [req.params.uid]);
        res.redirect(`/admin/users?password=${encodeURIComponent(password)}`);
    } catch (err) {
        res.status(500).send('Error unblocking user.');
    }
});
app.get('/admin/reviews', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) { return res.status(403).send('Access Denied'); }
    try {
        const { rows } = await pool.query('SELECT r.id, r.product_name, r.rating, r.review_text, r.reviewer_name, r.user_uid, u.email FROM reviews r JOIN users u ON r.user_uid = u.firebase_uid ORDER BY r.created_at DESC');
        const reviewsHtml = rows.map(r => `<tr>
            <td>${r.id}</td>
            <td>${he.encode(r.product_name)}</td>
            <td>${he.encode(r.reviewer_name)}<br>(${he.encode(r.email)})</td>
            <td>${'⭐'.repeat(r.rating)}</td>
            <td>${he.encode(r.review_text || '')}</td>
            <td>
                <form action="/admin/delete-review/${r.id}?password=${encodeURIComponent(password)}" method="POST" style="display:inline-block; margin-bottom: 5px;">
                    <button type="submit" onclick="return confirm('Are you sure you want to delete this review?');" style="color:red;">Delete Review</button>
                </form>
                <form action="/admin/block-user/${r.user_uid}?password=${encodeURIComponent(password)}" method="POST" style="display:inline-block;">
                    <button type="submit" onclick="return confirm('Are you sure you want to block this user from leaving future reviews?');" style="color:purple;">Block User</button>
                </form>
            </td>
        </tr>`).join('');

        res.send(`
            <!DOCTYPE html><html><head><title>Manage Reviews</title>
            <style>body{font-family:sans-serif;margin:2em} table{border-collapse:collapse;width:100%;} th,td{border:1px solid #ddd;padding:8px; text-align:left;} td:first-child, td:nth-child(4){text-align:center;}</style>
            </head><body>
            <h1>Manage Reviews</h1>
            <a href="/view-orders?password=${encodeURIComponent(password)}">Back to Orders</a>
            <table><thead><tr><th>ID</th><th>Product</th><th>Reviewer</th><th>Rating</th><th>Review Text</th><th>Actions</th></tr></thead>
            <tbody>${reviewsHtml}</tbody></table>
            </body></html>
        `);
    } catch (err) {
        console.error("Error loading reviews page:", err);
        res.status(500).send('Error loading reviews management page.');
    }
});
app.post('/admin/delete-review/:id', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) { return res.status(403).send('Access Denied'); }
    try {
        await pool.query('DELETE FROM reviews WHERE id = $1', [req.params.id]);
        res.redirect(`/admin/reviews?password=${encodeURIComponent(password)}`);
    } catch (err) {
        res.status(500).send('Error deleting review.');
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
