const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const Joi = require('joi');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const he = require('he');
require('dotenv').config();
const sgMail = require('@sendgrid/mail');

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
    max: 100,
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
        console.log('"products" table is ready.');
        await client.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY, customer_name VARCHAR(255) NOT NULL, phone_number VARCHAR(20) NOT NULL,
                address TEXT NOT NULL, cart_items JSONB, order_amount NUMERIC(10, 2) NOT NULL,
                razorpay_payment_id VARCHAR(255) NOT NULL, created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                user_uid VARCHAR(255) 
            );
        `);
        console.log('"orders" table is ready.');
        
        // MODIFIED: Added new columns to the users table
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255),
                phone_number VARCHAR(20),
                last_address TEXT,
                email VARCHAR(255) UNIQUE NOT NULL,
                firebase_uid VARCHAR(255) UNIQUE NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('"users" table is ready.');
    } catch (err) {
        console.error('Error setting up database tables:', err);
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

// --- Email Sending Functions ---
// ... (Your email functions remain unchanged)

// --- API Routes ---
// ... (Your other API routes are unchanged)

// MODIFIED: This route now accepts and saves name and phone
app.post('/api/user-login', async (req, res) => {
    const { email, uid, name, phone } = req.body;
    if (!email || !uid) {
        return res.status(400).json({ error: 'Email and UID are required.' });
    }
    try {
        const existingUser = await pool.query('SELECT * FROM users WHERE firebase_uid = $1', [uid]);
        if (existingUser.rows.length === 0) {
            // If user is new, insert their details
            await pool.query(
                'INSERT INTO users (email, firebase_uid, name, phone_number) VALUES ($1, $2, $3, $4)',
                [email, uid, name, phone]
            );
            console.log('New user created:', email);
        } else {
            console.log('Existing user logged in:', email);
        }
        res.status(200).json({ success: true, message: 'User session handled.' });
    } catch (err) {
        console.error('Error in user-login endpoint:', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

app.post('/checkout', verifyToken, async (req, res) => {
    const { cart, addressDetails, paymentId } = req.body;
    const user = req.user; 
    if (!cart || !addressDetails || !paymentId || Object.keys(cart).length === 0) {
        return res.status(400).json({ success: false, message: 'Missing required order information.' });
    }
    try {
        // ... (shipping calculation logic is unchanged)

        // Update the user's last address and phone number
        await pool.query(
            'UPDATE users SET last_address = $1, phone_number = $2 WHERE firebase_uid = $3',
            [addressDetails.address, addressDetails.phone, user.uid]
        );

        // ... (the rest of the checkout logic is unchanged)
        
    } catch (err) {
        console.error('Error during checkout:', err);
        res.status(500).json({ success: false, message: 'An internal server error occurred.' });
    }
});


// --- Admin Routes ---
// ... (Your product admin routes are unchanged)

// MODIFIED: Admin users page now shows name, phone, and address
app.get('/admin/users', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) { return res.status(403).send('Access Denied'); }
    try {
        const { rows } = await pool.query('SELECT name, email, phone_number, last_address, created_at FROM users ORDER BY created_at DESC');
        const usersHtml = rows.map(user => `
            <tr>
                <td>${he.encode(user.name || 'N/A')}</td>
                <td>${he.encode(user.email)}</td>
                <td>${he.encode(user.phone_number || 'N/A')}</td>
                <td>${he.encode(user.last_address || 'N/A')}</td>
                <td>${new Date(user.created_at).toLocaleString()}</td>
            </tr>
        `).join('');
        res.send(`<!DOCTYPE html><html><head><title>View Users</title><style>body{font-family:sans-serif;margin:2em}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px}th{background-color:#f2f2f2}</style></head><body><h1>Registered Users</h1><table><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Last Address</th><th>Registration Date</th></tr></thead><tbody>${usersHtml}</tbody></table></body></html>`);
    } catch (err) {
        res.status(500).send('Error loading users page.');
    }
});

// ... (Your other admin routes are unchanged)

// Final boilerplate
app.listen(port, () => {
    console.log(`Server is listening on port ${port}`);
    setupDatabase();
});

// --- HELPER FUNCTIONS AND OTHER ROUTES (PASTED FOR COMPLETENESS) ---

async function sendOrderConfirmationEmail(customerEmail, customerName, order, cart, subtotal, shippingCost, total) {
    const orderDate = new Date(order.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const itemsHtml = Object.keys(cart).map(name => {
        const item = cart[name];
        const displayName = name.charAt(0).toUpperCase() + name.slice(1);
        return `<tr><td style="padding: 10px; border-bottom: 1px solid #ddd;">${displayName} (x${item.quantity})</td><td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right;">₹${(item.price * item.quantity).toFixed(2)}</td></tr>`;
    }).join('');
    const emailHtml = `
      <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #ddd; padding: 20px;">
        <h1 style="color: #F97316; text-align: center;">Thank You For Your Order!</h1><p>Hi ${he.encode(customerName)},</p><p>We've received your order and will process it shortly. Here are the details:</p>
        <div style="border: 1px solid #eee; padding: 15px; margin: 20px 0;"><h2 style="margin-top: 0;">Invoice #${order.id}</h2><p><strong>Order Date:</strong> ${orderDate}</p>
          <table style="width: 100%; border-collapse: collapse;">
            <thead><tr><th style="padding: 10px; border-bottom: 2px solid #ddd; text-align: left;">Item</th><th style="padding: 10px; border-bottom: 2px solid #ddd; text-align: right;">Price</th></tr></thead>
            <tbody>${itemsHtml}<tr><td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right;">Subtotal:</td><td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right;">₹${subtotal.toFixed(2)}</td></tr><tr><td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right;">Shipping:</td><td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right;">₹${shippingCost.toFixed(2)}</td></tr><tr><td style="padding: 10px; font-weight: bold; text-align: right;">Total:</td><td style="padding: 10px; font-weight: bold; text-align: right;">₹${total.toFixed(2)}</td></tr></tbody>
          </table>
        </div><p style="font-size: 12px; color: #777; text-align: center;">This is an automated mail, please do not reply. For any questions, contact us at <a href="mailto:thebiharimakhana@gmail.com">thebiharimakhana@gmail.com</a>.</p>
      </div>`;
    const msg = { to: customerEmail, from: 'thebiharimakhana@gmail.com', subject: `Your The Bihari Makhana Order #${order.id} is Confirmed!`, html: emailHtml };
    try { await sgMail.send(msg); console.log('Confirmation email sent to', customerEmail); } catch (error) { console.error('Error sending confirmation email:', error); }
}

async function sendOrderCancellationEmail(customerEmail, customerName, orderId) {
    const emailHtml = `
      <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #ddd; padding: 20px;">
        <h1 style="color: #EF4444; text-align: center;">Your Order Has Been Cancelled</h1><p>Hi ${he.encode(customerName)},</p><p>This is to confirm that your order #${orderId} has been successfully cancelled. If you have already paid, a refund will be processed shortly.</p>
        <p>If you did not request this cancellation, please contact our support team immediately.</p><p style="font-size: 12px; color: #777; text-align: center;">This is an automated mail, please do not reply. For any questions, contact us at <a href="mailto:thebiharimakhana@gmail.com">thebiharimakhana@gmail.com</a>.</p>
      </div>`;
    const msg = { to: customerEmail, from: 'thebiharimakhana@gmail.com', subject: `Regarding Your The Bihari Makhana Order #${orderId}`, html: emailHtml };
    try { await sgMail.send(msg); console.log('Cancellation email sent to', customerEmail); } catch (error) { console.error('Error sending cancellation email:', error); }
}

// Full checkout route for completeness
app.post('/checkout', verifyToken, async (req, res) => {
    const { cart, addressDetails, paymentId } = req.body;
    const user = req.user; 
    if (!cart || !addressDetails || !paymentId || Object.keys(cart).length === 0) {
        return res.status(400).json({ success: false, message: 'Missing required order information.' });
    }
    try {
        let subtotal = 0;
        const cartItems = Object.keys(cart);
        for (const productName of cartItems) {
            const item = cart[productName];
            subtotal += item.price * item.quantity;
        }
        let shippingCost = 0;
        const isOnlySubscription = cartItems.length === 1 && cartItems[0].toLowerCase().includes('subsciption');
        if (isOnlySubscription) {
            shippingCost = 0;
        } else {
            shippingCost = subtotal >= 500 ? 0 : 99;
        }
        const totalAmount = subtotal + shippingCost;
        
        // Update user's last known address and phone
        await pool.query(
            'UPDATE users SET last_address = $1, phone_number = $2 WHERE firebase_uid = $3',
            [addressDetails.address, addressDetails.phone, user.uid]
        );

        const query = `
            INSERT INTO orders (customer_name, phone_number, address, cart_items, order_amount, razorpay_payment_id, user_uid)
            VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at
        `;
        const values = [
            addressDetails.name, addressDetails.phone, addressDetails.address, JSON.stringify(cart),
            totalAmount, paymentId, user.uid
        ];
        const orderResult = await pool.query(query, values);
        const newOrder = orderResult.rows[0];
        await sendOrderConfirmationEmail(user.email, addressDetails.name, newOrder, cart, subtotal, shippingCost, totalAmount);
        res.json({ success: true, message: 'Order placed successfully!' });
    } catch (err) {
        console.error('Error during checkout:', err);
        res.status(500).json({ success: false, message: 'An internal server error occurred.' });
    }
});

// Full admin routes for completeness
app.get('/admin/products', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) { return res.status(403).send('Access Denied'); }
    try {
        const { rows } = await pool.query('SELECT * FROM products ORDER BY id ASC');
        const productsHtml = rows.map(p => `<tr><td>${p.id}</td><td><img src="${p.image_url}" alt="${he.encode(p.name)}" width="50"></td><td>${he.encode(p.name)}</td><td>${p.price}</td><td>${p.sale_price || 'N/A'}</td><td>${p.stock_quantity}</td><td><a href="/admin/edit-product/${p.id}?password=${encodeURIComponent(password)}">Edit</a><form action="/admin/delete-product/${p.id}?password=${encodeURIComponent(password)}" method="POST" style="display:inline;"><button type="submit" onclick="return confirm('Are you sure?');">Delete</button></form></td></tr>`).join('');
        res.send(`<!DOCTYPE html><html><head><title>Manage Products</title><style>body{font-family:sans-serif;margin:2em}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px}img{max-width:50px}.add-form{margin-top:2em;padding:1em;border:1px solid #ddd}</style></head><body><h1>Manage Products</h1><table><thead><tr><th>ID</th><th>Image</th><th>Name</th><th>Price</th><th>Sale Price</th><th>Stock</th><th>Actions</th></tr></thead><tbody>${productsHtml}</tbody></table><div class="add-form"><h2>Add New Product</h2><form action="/add-product?password=${encodeURIComponent(password)}" method="POST"><p><label>Name: <input name="productName" required></label></p><p><label>Price: <input name="price" type="number" step="0.01" required></label></p><p><label>Sale Price: <input name="salePrice" type="number" step="0.01"></label></p><p><label>Stock: <input name="stockQuantity" type="number" value="10" required></label></p><p><label>Description: <textarea name="description" required></textarea></label></p><p><label>Image URL: <input name="imageUrl" required></label></p><button type="submit">Add Product</button></form></div></body></html>`);
    } catch (err) {
        res.status(500).send('Error loading product management page.');
    }
});
app.post('/add-product', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) { return res.status(403).send('Access Denied'); }
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
app.get('/view-orders', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) { return res.status(403).send('Access Denied'); }
    try {
        const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
        let html = `<h1>All Orders</h1><table border="1" style="width:100%; border-collapse: collapse;"><thead><tr><th>ID</th><th>Customer</th><th>Address</th><th>Amount</th><th>Payment ID</th><th>Date</th><th>Items</th><th>Actions</th></tr></thead><tbody>`;
        rows.forEach(order => {
            let itemsHtml = 'N/A';
            if (order.cart_items) {
                try {
                    const items = (typeof order.cart_items === 'string') ? JSON.parse(order.cart_items) : order.cart_items;
                    itemsHtml = '<ul>' + Object.keys(items).map(key => `<li>${he.encode(key)} (x${items[key].quantity})</li>`).join('') + '</ul>';
                } catch (e) { itemsHtml = '<span style="color:red;">Invalid data</span>'; }
            }
            html += `<tr><td>${order.id}</td><td>${he.encode(order.customer_name)}<br>${he.encode(order.phone_number)}</td><td>${he.encode(order.address)}</td><td>₹${order.order_amount}</td><td>${he.encode(order.razorpay_payment_id)}</td><td>${new Date(order.created_at).toLocaleString()}</td><td>${itemsHtml}</td><td><form action="/admin/cancel-order/${order.id}?password=${encodeURIComponent(password)}" method="POST" style="display:inline-block; margin-bottom: 5px;"><button type="submit" onclick="return confirm('Cancel and notify?');" style="color:orange;">Cancel & Notify</button></form><form action="/admin/delete-order/${order.id}?password=${encodeURIComponent(password)}" method="POST" style="display:inline-block;"><button type="submit" onclick="return confirm('Permanently DELETE?');" style="color:red;">Delete</button></form></td></tr>`;
        });
        html += '</tbody></table>';
        res.send(html);
    } catch (err) {
        res.status(500).send('Internal Server Error');
    }
});
app.post('/admin/cancel-order/:id', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) { return res.status(403).send('Access Denied'); }
    try {
        const { id } = req.params;
        const orderResult = await pool.query('SELECT user_uid, customer_name FROM orders WHERE id = $1', [id]);
        if (orderResult.rows.length === 0) { return res.status(404).send('Order not found.'); }
        const order = orderResult.rows[0];
        const userResult = await pool.query('SELECT email FROM users WHERE firebase_uid = $1', [order.user_uid]);
        if (userResult.rows.length === 0) { return res.status(404).send('Customer email not found.'); }
        const customerEmail = userResult.rows[0].email;
        await sendOrderCancellationEmail(customerEmail, order.customer_name, id);
        await pool.query('DELETE FROM orders WHERE id = $1', [id]);
        res.send(`Order #${id} cancelled. Email sent to ${customerEmail}. <a href="/view-orders?password=${encodeURIComponent(password)}">Back to orders.</a>`);
    } catch (err) {
        res.status(500).send('Error cancelling order.');
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

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something broke!');
});
