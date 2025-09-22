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

// The main admin dashboard
app.get('/admin/products', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) {
        return res.status(403).send('Access Denied');
    }

    try {
        const { rows } = await pool.query('SELECT * FROM products ORDER BY id ASC');
        let productsHtml = rows.map(p => `
            <tr>
                <td>${p.id}</td>
                <td><img src="${p.image_url}" alt="${he.encode(p.name)}" width="50"></td>
                <td>${he.encode(p.name)}</td>
                <td>${p.price}</td>
                <td>${p.sale_price || 'N/A'}</td>
                <td>${p.stock_quantity}</td>
                <td>
                    <button>Edit</button>
                    <form action="/admin/delete-product/${p.id}?password=${encodeURIComponent(password)}" method="POST" style="display:inline;">
                        <button type="submit" onclick="return confirm('Are you sure you want to delete this product?');">Delete</button>
                    </form>
                </td>
            </tr>
        `).join('');

        res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <title>Manage Products</title>
                <style>
                    body { font-family: sans-serif; margin: 2em; }
                    table { border-collapse: collapse; width: 100%; }
                    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
                    th { background-color: #f2f2f2; }
                    tr:nth-child(even) { background-color: #f9f9f9; }
                    img { max-width: 50px; height: auto; }
                    .add-form { margin-top: 2em; padding: 1em; border: 1px solid #ddd; }
                </style>
            </head>
            <body>
                <h1>Manage Products</h1>
                <table>
                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>Image</th>
                            <th>Name</th>
                            <th>Price</th>
                            <th>Sale Price</th>
                            <th>Stock</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${productsHtml}
                    </tbody>
                </table>

                <div class="add-form">
                    <h2>Add New Product</h2>
                    <form action="/add-product?password=${encodeURIComponent(password)}" method="POST">
                        <p><label>Name: <input name="productName" required></label></p>
                        <p><label>Price (e.g., 199.00): <input name="price" type="number" step="0.01" required></label></p>
                        <p><label>Description: <textarea name="description" required></textarea></label></p>
                        <p><label>Image URL: <input name="imageUrl" required></label></p>
                        <button type="submit">Add Product</button>
                    </form>
                </div>
            </body>
            </html>
        `);
    } catch (err) {
        console.error('Error fetching products for admin:', err);
        res.status(500).send('Error loading product management page.');
    }
});

// THIS IS THE NEW ROUTE TO HANDLE THE DELETE REQUEST
app.post('/admin/delete-product/:id', async (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) {
        return res.status(403).send('Access Denied');
    }
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM products WHERE id = $1', [id]);
        // Redirect back to the products management page after deletion
        res.redirect(`/admin/products?password=${encodeURIComponent(password)}`);
    } catch (err) {
        console.error('Error deleting product:', err);
        res.status(500).send('Error deleting product.');
    }
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
        res.redirect(`/admin/products?password=${encodeURIComponent(password)}`);
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
