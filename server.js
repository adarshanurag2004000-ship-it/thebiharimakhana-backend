const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Joi = require('joi');
const he = require('he');

const app = express();
const PORT = process.env.PORT || 3001;

// --- SECURITY ---
app.use(helmet());
const limiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	max: 100,
	standardHeaders: true,
	legacyHeaders: false,
    message: 'Too many requests from this IP, please try again after 15 minutes'
});
app.use(limiter);
const allowedOrigins = [
    'https://inspiring-cranachan-69450a.netlify.app',
    'http://localhost:3000'
];
const corsOptions = {
  origin: function (origin, callback) {
    if (allowedOrigins.indexOf(origin) !== -1 || !origin) {
      callback(null, true)
    } else {
      callback(new Error('Not allowed by CORS'))
    }
  }
};
app.use(cors(corsOptions));
// --- END SECURITY ---

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Middleware to parse form data

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const setupDatabase = async () => {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                customer_name VARCHAR(255) NOT NULL,
                phone VARCHAR(20) NOT NULL,
                address TEXT NOT NULL,
                cart_items JSONB NOT NULL,
                payment_id VARCHAR(255) NOT NULL,
                order_date TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        console.log('Database table "orders" is ready.');

        await client.query(`
            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                price NUMERIC(10, 2) NOT NULL,
                image_url VARCHAR(255) NOT NULL,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        console.log('Database table "products" is ready.');

    } catch (err) {
        console.error('Error setting up database tables:', err);
    } finally {
        client.release();
    }
};

app.get('/', (req, res) => {
  res.send('The Bihari Makhana backend is running and connected to the database!');
});

// --- ADMIN SECTION ---

// Middleware to check admin password
const checkAdminPassword = (req, res, next) => {
    const password = req.query.password || req.body.password;
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword || password !== adminPassword) {
        return res.status(401).send('<h1>Access Denied</h1>');
    }
    next();
};

app.get('/view-orders', checkAdminPassword, async (req, res, next) => {
    try {
        const client = await pool.connect();
        const result = await client.query('SELECT * FROM orders ORDER BY order_date DESC;');
        const orders = result.rows;
        client.release();

        let html = `
            <style>
                body { font-family: sans-serif; margin: 20px; } .order { border: 1px solid #ccc; padding: 15px; margin-bottom: 20px; border-radius: 8px; } h1 { color: #F97316; } h2 { border-bottom: 2px solid #eee; padding-bottom: 5px; } pre { background-color: #f4f4f4; padding: 10px; border-radius: 5px; white-space: pre-wrap; word-wrap: break-word; }
            </style>
            <h1>The Bihari Makhana - Orders</h1> <p>Found ${orders.length} orders.</p>
        `;

        orders.forEach(order => {
            const safePaymentId = he.encode(order.payment_id); const safeCustomerName = he.encode(order.customer_name); const safePhone = he.encode(order.phone); const safeAddress = he.encode(order.address); const safeCartItems = he.encode(JSON.stringify(order.cart_items, null, 2));
            html += `
                <div class="order">
                    <h2>Order #${order.id} - ${new Date(order.order_date).toLocaleString()}</h2> <p><strong>Payment ID:</strong> ${safePaymentId}</p> <h3>Customer Details:</h3> <p><strong>Name:</strong> ${safeCustomerName}</p> <p><strong>Phone:</strong> ${safePhone}</p> <p><strong>Address:</strong> ${safeAddress}</p> <h3>Cart Items:</h3> <pre>${safeCartItems}</pre>
                </div>
            `;
        });
        res.send(html);
    } catch (err) {
        next(err);
    }
});

// Admin page to add products
app.get('/admin', checkAdminPassword, (req, res) => {
    const adminPassword = process.env.ADMIN_PASSWORD;
    res.send(`
        <style>
            body { font-family: sans-serif; margin: 40px; background-color: #f9fafb; }
            .container { max-width: 600px; margin: auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
            h1 { color: #F97316; }
            label { display: block; margin-top: 20px; font-weight: bold; }
            input, textarea { width: 100%; padding: 10px; margin-top: 5px; border-radius: 4px; border: 1px solid #ccc; box-sizing: border-box; }
            button { background-color: #F97316; color: white; padding: 12px 20px; border: none; border-radius: 4px; cursor: pointer; font-size: 16px; margin-top: 20px; }
            button:hover { background-color: #ea580c; }
        </style>
        <div class="container">
            <h1>Admin Control Panel</h1>
            <h2>Add New Product</h2>
            <form action="/admin/add-product" method="POST">
                <input type="hidden" name="password" value="${he.encode(adminPassword)}">
                
                <label for="name">Product Name:</label>
                <input type="text" id="name" name="name" required>
                
                <label for="price">Price (e.g., 199.00):</label>
                <input type="text" id="price" name="price" required>
                
                <label for="description">Description:</label>
                <textarea id="description" name="description" rows="4" required></textarea>
                
                <label for="image_url">Image URL:</label>
                <input type="text" id="image_url" name="image_url" required>
                
                <button type="submit">Add Product</button>
            </form>
        </div>
    `);
});

// Endpoint to handle adding the product
app.post('/admin/add-product', checkAdminPassword, async (req, res, next) => {
    const { name, price, description, image_url } = req.body;

    // --- STRONGER VALIDATION ---
    const parsedPrice = parseFloat(price);
    if (!name || !price || !description || !image_url) {
        return res.status(400).send('<h1>Error</h1><p>All fields are required.</p><a href="/admin?password=' + he.encode(process.env.ADMIN_PASSWORD) + '">Go Back</a>');
    }
    if (isNaN(parsedPrice) || parsedPrice <= 0) {
        return res.status(400).send('<h1>Error</h1><p>Price must be a valid positive number (e.g., 199.50).</p><a href="/admin?password=' + he.encode(process.env.ADMIN_PASSWORD) + '">Go Back</a>');
    }
    // --- END VALIDATION ---

    try {
        const client = await pool.connect();
        await client.query(
            'INSERT INTO products (name, price, description, image_url) VALUES ($1, $2, $3, $4)',
            [name, parsedPrice, description, image_url] // Use the validated, parsed price
        );
        client.release();
        res.send('<h1>Product Added Successfully!</h1><a href="/admin?password=' + he.encode(process.env.ADMIN_PASSWORD) + '">Add another product</a>');
    } catch(err) {
        next(err);
    }
});


// --- CUSTOMER SECTION ---
const checkoutSchema = Joi.object({
    paymentId: Joi.string().trim().required(), cart: Joi.object().min(1).required(), addressDetails: Joi.object({ name: Joi.string().trim().min(2).max(100).required(), phone: Joi.string().trim().pattern(/^[0-9]{10,15}$/).required(), address: Joi.string().trim().min(10).max(500).required() }).required()
});

app.post('/checkout', async (req, res, next) => {
    const { error, value } = checkoutSchema.validate(req.body);
    if (error) {
        console.log("Validation Error:", error.details[0].message);
        return res.status(422).json({ success: false, message: `Invalid input: ${error.details[0].message}` });
    }
    const { cart, addressDetails, paymentId } = value;
    const insertQuery = `INSERT INTO orders (customer_name, phone, address, cart_items, payment_id) VALUES ($1, $2, $3, $4, $5);`;
    const values = [addressDetails.name, addressDetails.phone, addressDetails.address, cart, paymentId];
    try {
        const client = await pool.connect();
        await client.query(insertQuery, values);
        client.release();
        console.log('--- SUCCESS: ORDER SAVED TO DATABASE ---');
        res.json({ success: true, message: "Order saved successfully!" });
    } catch (err) {
        next(err);
    }
});

// --- CENTRAL ERROR HANDLER ---
app.use((err, req, res, next) => {
    console.error('--- UNHANDLED ERROR ---', err.stack);
    res.status(500).json({ success: false, message: 'An unexpected error occurred. Please try again later.' });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  setupDatabase();
});

