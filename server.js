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

// --- API Routes ---
app.get('/', async (req, res) => {
    res.send('The Bihari Makhana Backend is running.');
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

// MODIFIED: Temporarily removed user_uid from the INSERT statement
app.post('/checkout', verifyToken, async (req, res) => {
    const { cart, addressDetails, paymentId } = req.body;
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
            INSERT INTO orders (customer_name, phone_number, address, cart_items, order_amount, razorpay_payment_id)
            VALUES ($1, $2, $3, $4, $5, $6)
        `;
        const values = [
            addressDetails.name,
            addressDetails.phone,
            addressDetails.address,
            JSON.stringify(cart),
            totalAmount,
            paymentId
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
// (Your admin routes are unchanged)

app.listen(port, () => {
    console.log(`Server is listening on port ${port}`);
    setupDatabase();
});
