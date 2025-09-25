const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const Joi = require('joi');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const he = require('he');
require('dotenv').config();

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
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                price NUMERIC(10, 2) NOT NULL,
                description TEXT,
                image_url VARCHAR(2048),
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                sale_price NUMERIC(10, 2),
                stock_quantity INTEGER NOT NULL DEFAULT 10
            );
        `);
        console.log('"products" table is ready.');

        // CORRECTED: Added user_uid column to orders table definition
        await client.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                customer_name VARCHAR(255) NOT NULL,
                phone_number VARCHAR(20) NOT NULL,
                address TEXT NOT NULL,
                cart_items JSONB,
                order_amount NUMERIC(10, 2) NOT NULL,
                razorpay_payment_id VARCHAR(255) NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                user_uid VARCHAR(255) 
            );
        `);
        console.log('"orders" table is ready.');
        
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
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

// --- Validation Schemas ---
const productSchema = Joi.object({
    productName: Joi.string().min(3).max(100).required(),
    price: Joi.number().positive().precision(2).required(),
    salePrice: Joi.number().positive().precision(2).allow(null, ''),
    stockQuantity: Joi.number().integer().min(0).required(),
    description: Joi.string().min(10).max(1000).required(),
    imageUrl: Joi.string().uri().max(2048).required()
});


// --- API Routes ---
app.get('/', async (req, res) => {
    try {
        await pool.query('SELECT NOW()');
        res.send('The Bihari Makhana Backend is running and connected to the database.');
    } catch (err) {
        res.status(500).send('Backend is running, but could not connect to the database.');
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
        console.error('Error fetching products:', err);
        res.status(500).send('Error fetching products');
    }
});

app.post('/api/calculate-total', (req, res) => {
    const { cart } = req.body;
    if (!cart || Object.keys(cart).length === 0) {
      return res.status(400).json({ error: 'Cart data is missing or empty.' });
    }
    let subtotal = 0;
    const cartItems = Object.keys(cart);
    for (const productName of cartItems) {
      const item = cart[productName];
      if (typeof item.price === 'number' && typeof item.quantity === 'number') {
          subtotal += item.price * item.quantity;
      }
    }
    let shippingCost = 0;
    const isOnlySubscription = cartItems.length === 1 && cartItems[0].toLowerCase().includes('subsciption');
    if (isOnlySubscription) {
        shippingCost = 0;
    } else {
        shippingCost = subtotal >= 500 ? 0 : 99;
    }
    const total = subtotal + shippingCost;
    res.json({ subtotal: subtotal, shippingCost: shippingCost, total: total });
});

app.post('/checkout', verifyToken, async (req, res) => {
    const { cart, addressDetails, paymentId } = req.body;
    const userUid = req.user.uid; 
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
        const query = `
            INSERT INTO orders (customer_name, phone_number, address, cart_items, order_amount, razorpay_payment_id, user_uid)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `;
        const values = [
            addressDetails.name,
            addressDetails.phone,
            addressDetails.address,
            JSON.stringify(cart),
            totalAmount,
            paymentId,
            userUid
        ];
        await pool.query(query, values);
        res.json({ success: true, message: 'Order placed successfully!' });
    } catch (err) {
        console.error('Error during checkout:', err);
        res.status(500).json({ success: false, message: 'An internal server error occurred.' });
    }
});

app.post('/api/user-login', async (req, res) => {
    const { email, uid } = req.body;
    if (!email || !uid) {
        return res.status(400).json({ error: 'Email and UID are required.' });
    }
    try {
        const existingUser = await pool.query('SELECT * FROM users WHERE firebase_uid = $1', [uid]);
        if (existingUser.rows.length === 0) {
            await pool.query(
                'INSERT INTO users (email, firebase_uid) VALUES ($1, $2)',
                [email, uid]
            );
        }
        res.status(200).json({ success: true, message: 'User session handled.' });
    } catch (err) {
        console.error('Error in user-login endpoint:', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

app.get('/api/my-orders', verifyToken, async (req, res) => {
    try {
        const userUid = req.user.uid;
        const { rows } = await pool.query(
            'SELECT id, order_amount, created_at, cart_items FROM orders WHERE user_uid = $1 ORDER BY created_at DESC', 
            [userUid]
        );
        res.json(rows);
    } catch (err) {
        console.error('Error fetching user orders:', err);
        res.status(500).send('Error fetching orders.');
    }
});

// --- Admin Routes ---
app.get('/admin/products', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) { return res.status(403).send('Access Denied'); }
    try {
        const { rows } = await pool.query('SELECT * FROM products ORDER BY id ASC');
        const productsHtml = rows.map(p => `
            <tr>
                <td>${p.id}</td>
                <td><img src="${p.image_url}" alt="${he.encode(p.name)}" width="50"></td>
                <td>${he.encode(p.name)}</td>
                <td>${p.price}</td>
                <td>${p.sale_price || 'N/A'}</td>
                <td>${p.stock_quantity}</td>
                <td>
                    <a href="/admin/edit-product/${p.id}?password=${encodeURIComponent(password)}">Edit</a>
                    <form action="/admin/delete-product/${p.id}?password=${encodeURIComponent(password)}" method="POST" style="display:inline;">
                        <button type="submit" onclick="return confirm('Are you sure you want to delete this product?');">Delete</button>
                    </form>
                </td>
            </tr>
        `).join('');
        res.send(`<!DOCTYPE html><html lang="en"><head><title>Manage Products</title><style>body{font-family:sans-serif;margin:2em}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background-color:#f2f2f2}img{max-width:50px}.add-form{margin-top:2em;padding:1em;border:1px solid #ddd}</style></head><body><h1>Manage Products</h1><table><thead><tr><th>ID</th><th>Image</th><th>Name</th><th>Price</th><th>Sale Price</th><th>Stock</th><th>Actions</th></tr></thead><tbody>${productsHtml}</tbody></table><div class="add-form"><h2>Add New Product</h2><form action="/add-product?password=${encodeURIComponent(password)}" method="POST"><p><label>Name: <input name="productName" required></label></p><p><label>Price (e.g., 199.00): <input name="price" type="number" step="0.01" required></label></p><p><label>Sale Price (optional): <input name="salePrice" type="number" step="0.01"></label></p><p><label>Stock Quantity: <input name="stockQuantity" type="number" value="10" required></label></p><p><label>Description: <textarea name="description" required></textarea></label></p><p><label>Image URL: <input name="imageUrl" required></label></p><button type="submit">Add Product</button></form></div></body></html>`);
    } catch (err) {
        res.status(500).send('Error loading product management page.');
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
        res.send(`<!DOCTYPE html><html lang="en"><head><title>Edit Product</title><style>body{font-family:sans-serif;margin:2em}label,input,textarea{display:block;width:300px;margin-bottom:1em}</style></head><body><h1>Edit Product: ${he.encode(p.name)}</h1><form action="/admin/update-product/${p.id}?password=${encodeURIComponent(password)}" method="POST"><p><label>Name: <input name="productName" value="${he.encode(p.name)}" required></label></p><p><label>Price (e.g., 199.00): <input name="price" type="number" step="0.01" value="${p.price}" required></label></p><p><label>Sale Price (optional): <input name="salePrice" type="number" step="0.01" value="${p.sale_price || ''}"></label></p><p><label>Stock Quantity: <input name="stockQuantity" type="number" value="${p.stock_quantity}" required></label></p><p><label>Description: <textarea name="description" required>${he.encode(p.description)}</textarea></label></p><p><label>Image URL: <input name="imageUrl" value="${p.image_url}" required></label></p><button type="submit">Update Product</button></form></body></html>`);
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
app.get('/view-orders', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) { return res.status(403).send('Access Denied'); }
    try {
        const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
        let html = `<h1>All Orders</h1><table border="1" style="width:100%; border-collapse: collapse;"><thead><tr><th>ID</th><th>Customer</th><th>Address</th><th>Amount</th><th>Payment ID</th><th>Date</th><th>Items</th></tr></thead><tbody>`;
        rows.forEach(order => {
            let itemsHtml = 'N/A';
            if (order.cart_items) {
                try {
                    const items = (typeof order.cart_items === 'string') ? JSON.parse(order.cart_items) : order.cart_items;
                    itemsHtml = '<ul>' + Object.keys(items).map(key => `<li>${he.encode(key)} (x${items[key].quantity})</li>`).join('') + '</ul>';
                } catch (e) { itemsHtml = '<span style="color:red;">Invalid item data</span>'; }
            }
            html += `<tr><td>${order.id}</td><td>${he.encode(order.customer_name)}<br>${he.encode(order.phone_number)}</td><td>${he.encode(order.address)}</td><td>₹${order.order_amount}</td><td>${he.encode(order.razorpay_payment_id)}</td><td>${new Date(order.created_at).toLocaleString()}</td><td>${itemsHtml}</td></tr>`;
        });
        html += '</tbody></table>';
        res.send(html);
    } catch (err) {
        res.status(500).send('Internal Server Error');
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
