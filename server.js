const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const Joi = require('joi');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const he = require('he');
require('dotenv').config();

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
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
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
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('"orders" table is ready.');
    } catch (err) {
        console.error('Error setting up database tables:', err);
    } finally {
        client.release();
    }
}

// --- Validation Schemas ---
const productSchema = Joi.object({
    productName: Joi.string().min(3).max(100).required(),
    // THIS LINE IS NOW FIXED
    price: Joi.number().positive().precision(2).required(),
    description: Joi.string().min(10).max(1000).required(),
    imageUrl: Joi.string().uri().max(2048).required()
});

// --- API Routes ---
app.get('/', async (req, res) => {
    try {
        const client = await pool.connect();
        res.send('The Bihari Makhana Backend is running and connected to the database.');
        client.release();
    } catch (err) {
        res.status(500).send('Backend is running, but could not connect to the database.');
    }
});

app.get('/api/products', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM products ORDER BY created_at DESC');
        res.json(rows);
    } catch (err) {
        res.status(500).send('Error fetching products');
    }
});

// --- Admin Routes ---
app.get('/admin/fix-products-table', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) {
        return res.status(403).send('Access Denied');
    }
    const client = await pool.connect();
    try {
        await client.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS sale_price NUMERIC(10, 2);');
        await client.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_quantity INTEGER NOT NULL DEFAULT 10;');
        
        res.send('<h1>Success! The products table has been upgraded.</h1><p>The `sale_price` and `stock_quantity` columns have been added. You are ready for the next features.</p>');
    } catch (err) {
        console.error('Error fixing products table:', err);
        res.status(500).send('An error occurred while upgrading the products table.');
    } finally {
        client.release();
    }
});


app.get('/admin/fix-database', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) {
        return res.status(403).send('Access Denied');
    }
    const client = await pool.connect();
    try {
        await client.query('DROP TABLE IF EXISTS orders;');
        await client.query(`
            CREATE TABLE orders (
                id SERIAL PRIMARY KEY,
                customer_name VARCHAR(255) NOT NULL,
                phone_number VARCHAR(20) NOT NULL,
                address TEXT NOT NULL,
                cart_items JSONB,
                order_amount NUMERIC(10, 2) NOT NULL,
                razorpay_payment_id VARCHAR(255) NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        res.send('<h1>Success! The orders table has been completely rebuilt.</h1><p>The error is now permanently fixed. Please try your /view-orders page again.</p><p><a href="/view-orders?password=' + encodeURIComponent(password) + '">Click here to verify.</a></p>');
    } catch (err) {
        console.error('Error fixing database:', err);
        res.status(500).send('An error occurred while fixing the database.');
    } finally {
        client.release();
    }
});

app.get('/admin', (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) {
        return res.status(403).send('Access Denied');
    }
    res.send(`
        <!DOCTYPE html><html lang="en"><head><title>Admin Panel</title></head><body><h1>Admin Control Panel</h1><form action="/add-product?password=${encodeURIComponent(password)}" method="POST"><h2>Add New Product</h2><label>Name:</label><input name="productName" required><br><label>Price:</label><input name="price" type="number" step="0.01" required><br><label>Description:</label><textarea name="description" required></textarea><br><label>Image URL:</label><input name="imageUrl" required><br><button type="submit">Add Product</button></form></body></html>
    `);
});

app.post('/add-product', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) {
        return res.status(403).send('Access Denied');
    }
    const { error, value } = productSchema.validate(req.body);
    if (error) {
        return res.status(400).send(error.details[0].message);
    }
    try {
        await pool.query('INSERT INTO products(name, price, description, image_url) VALUES($1, $2, $3, $4)', [value.productName, value.price, value.description, value.imageUrl]);
        res.send(`<h1>Product Added!</h1><a href="/admin?password=${encodeURIComponent(password)}">Go Back</a>`);
    } catch (err) {
        res.status(500).send('Error adding product.');
    }
});

app.get('/view-orders', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) {
        return res.status(403).send('Access Denied');
    }
    try {
        const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
        let html = `<h1>All Orders</h1><table border="1"><tr><th>ID</th><th>Customer</th><th>Address</th><th>Amount</th><th>Payment ID</th><th>Date</th><th>Items</th></tr>`;
        rows.forEach(order => {
            let itemsHtml = 'N/A';
            if (order.cart_items) {
                try {
                    const items = (typeof order.cart_items === 'string') ? JSON.parse(order.cart_items) : order.cart_items;
                    itemsHtml = '<ul>' + Object.keys(items).map(key => `<li>${he.encode(key)} (x${items[key].quantity})</li>`).join('') + '</ul>';
                } catch (e) {
                    itemsHtml = '<span style="color:red;">Invalid item data</span>';
                }
            }
            html += `<tr><td>${order.id}</td><td>${he.encode(order.customer_name)}<br>${he.encode(order.phone_number)}</td><td>${he.encode(order.address)}</td><td>₹${order.order_amount}</td><td>${he.encode(order.razorpay_payment_id)}</td><td>${new Date(order.created_at).toLocaleString()}</td><td>${itemsHtml}</td></tr>`;
        });
        html += '</table>';
        res.send(html);
    } catch (err) {
        console.error('Error fetching orders:', err);
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
