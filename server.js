const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const cors = require('cors');
const Joi = require('joi');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const he = require('he');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// --- Security Middleware ---

app.use(helmet());

// UPDATED: Added your backend URL to the whitelist for API calls from itself
const whitelist = ['https://inspiring-cranachan-69450a.netlify.app', 'https://thebiharimakhana-backend.onrender.com'];
const corsOptions = {
  origin: function (origin, callback) {
    if (whitelist.indexOf(origin) !== -1 || !origin) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
};
app.use(cors(corsOptions));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// --- Database Setup ---

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
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        customer_name VARCHAR(255) NOT NULL,
        phone_number VARCHAR(20) NOT NULL,
        address TEXT NOT NULL,
        razorpay_payment_id VARCHAR(255) NOT NULL,
        order_amount NUMERIC(10, 2) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('"orders" table is ready.');

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

  } catch (err) {
    console.error('Error setting up database tables:', err);
  } finally {
    client.release();
  }
}

// --- Middleware for parsing request bodies ---
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));


// --- Validation Schemas ---

const orderSchema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  phone: Joi.string().pattern(/^[0-9]{10,15}$/).required(),
  address: Joi.string().min(5).max(500).required(),
  razorpay_payment_id: Joi.string().required(),
  amount: Joi.number().positive().required()
});

const productSchema = Joi.object({
    productName: Joi.string().min(3).max(100).required(),
    price: Joi.number().positive().precision(2).required(),
    description: Joi.string().min(10).max(1000).required(),
    imageUrl: Joi.string().uri().max(2048).required()
});


// --- Public API Routes ---

app.get('/', (req, res) => {
  res.send('The Bihari Makhana Backend is running!');
});

// NEW: Public endpoint for the website to get all products
app.get('/api/products', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM products ORDER BY created_at ASC');
        res.json(rows);
    } catch (err) {
        console.error('Error fetching products:', err);
        res.status(500).json({ message: 'Error fetching products' });
    }
});


app.post('/save-order', async (req, res) => {
  const { error, value } = orderSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ message: `Validation error: ${error.details[0].message}` });
  }

  const { name, phone, address, razorpay_payment_id, amount } = value;

  try {
    const query = 'INSERT INTO orders(customer_name, phone_number, address, razorpay_payment_id, order_amount) VALUES($1, $2, $3, $4, $5) RETURNING id';
    const values = [name, phone, address, razorpay_payment_id, amount / 100]; // Convert paise to rupees
    const result = await pool.query(query, values);
    res.status(200).json({ message: 'Order saved successfully!', orderId: result.rows[0].id });
  } catch (err) {
    console.error('Error saving order:', err);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});


// --- Admin Routes ---

app.get('/view-orders', async (req, res) => {
  const { password } = req.query;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(403).send('Access Denied');
  }

  try {
    const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    let html = `<style>body { font-family: sans-serif; margin: 2em; } table { border-collapse: collapse; width: 100%; } th, td { border: 1px solid #ddd; padding: 8px; text-align: left; } th { background-color: #f2f2f2; } tr:nth-child(even) { background-color: #f9f9f9; }</style><h1>All Orders</h1><table><tr><th>ID</th><th>Name</th><th>Phone</th><th>Address</th><th>Amount</th><th>Payment ID</th><th>Date</th></tr>`;
    rows.forEach(order => {
      html += `<tr><td>${he.encode(String(order.id))}</td><td>${he.encode(order.customer_name)}</td><td>${he.encode(order.phone_number)}</td><td>${he.encode(order.address)}</td><td>₹${he.encode(String(order.order_amount))}</td><td>${he.encode(order.razorpay_payment_id)}</td><td>${new Date(order.created_at).toLocaleString()}</td></tr>`;
    });
    html += '</table>';
    res.send(html);
  } catch (err) {
    console.error('Error fetching orders:', err);
    res.status(500).send('Internal Server Error');
  }
});

app.get('/admin', (req, res) => {
    const { password } = req.query;
    if (password !== process.env.ADMIN_PASSWORD) {
        return res.status(403).send('Access Denied');
    }

    res.send(`
        <!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Admin Panel</title><style>body { font-family: Arial, sans-serif; background-color: #f4f4f9; margin: 40px; } .container { max-width: 600px; margin: auto; background: #fff; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); } h1 { color: #333; } label { display: block; margin-top: 10px; color: #555; } input[type="text"], input[type="number"], textarea { width: 100%; padding: 10px; margin-top: 5px; border-radius: 4px; border: 1px solid #ddd; box-sizing: border-box; } button { background-color: #007bff; color: white; padding: 10px 15px; border: none; border-radius: 4px; cursor: pointer; font-size: 16px; margin-top: 20px; } button:hover { background-color: #0056b3; }</style></head><body><div class="container"><h1>Admin Control Panel</h1><form action="/add-product" method="POST"><h2>Add New Product</h2><label for="productName">Product Name:</label><input type="text" id="productName" name="productName" required><label for="price">Price (INR):</label><input type="number" id="price" name="price" step="0.01" required><label for="description">Description:</label><textarea id="description" name="description" rows="4" required></textarea><label for="imageUrl">Image URL:</label><input type="text" id="imageUrl" name="imageUrl" required><button type="submit">Add Product</button></form></div></body></html>
    `);
});

app.post('/add-product', async (req, res) => {
    const { error, value } = productSchema.validate(req.body);
    if (error) {
        return res.status(400).send(`Validation error: ${error.details[0].message}`);
    }

    const { productName, price, description, imageUrl } = value;
    
    try {
        const query = 'INSERT INTO products(name, price, description, image_url) VALUES($1, $2, $3, $4)';
        const values = [productName, price, description, imageUrl];
        await pool.query(query, values);
        res.send('<h1>Product Added Successfully!</h1><a href="javascript:history.back()">Go Back To Admin Panel</a>');
    } catch (err) {
        console.error('Error adding product:', err);
        res.status(500).send('Internal Server Error while adding product.');
    }
});


// --- Global Error Handler ---
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something broke!');
});


// --- Start Server ---

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  setupDatabase();
});
