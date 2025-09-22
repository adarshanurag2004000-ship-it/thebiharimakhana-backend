const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const helmet = require('helmet'); // Security: Adds various HTTP security headers
const rateLimit = require('express-rate-limit'); // Security: Prevents brute-force attacks

const app = express();
const PORT = process.env.PORT || 3001;

// --- SECURITY ENHANCEMENTS ---

// 1. Use Helmet to set secure HTTP headers
app.use(helmet());

// 2. Rate Limiting to prevent spam and brute-force attacks
const limiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 minutes
	max: 100, // Limit each IP to 100 requests per windowMs
	standardHeaders: true,
	legacyHeaders: false,
    message: 'Too many requests from this IP, please try again after 15 minutes'
});
app.use(limiter); // Apply the limiter to all requests

// 3. CORS Whitelist: Only allow your website to communicate with this backend
const allowedOrigins = [
    'https://inspiring-cranachan-69450a.netlify.app', // Your official website URL
    'http://localhost:3000' // For testing on your computer
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
// --- END OF SECURITY ENHANCEMENTS ---

app.use(express.json());

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
    } catch (err) {
        console.error('Error setting up database table:', err);
    } finally {
        client.release();
    }
};

app.get('/', (req, res) => {
  res.send('The Bihari Makhana backend is running and connected to the database!');
});

// THIS IS THE SECURED PAGE TO VIEW YOUR ORDERS
app.get('/view-orders', async (req, res) => {
    const { password } = req.query;
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminPassword || password !== adminPassword) {
        return res.status(401).send('<h1>Access Denied</h1><p>You need a valid password to view this page.</p>');
    }

    try {
        const client = await pool.connect();
        const result = await client.query('SELECT * FROM orders ORDER BY order_date DESC;');
        const orders = result.rows;
        client.release();

        let html = `
            <style>
                body { font-family: sans-serif; margin: 20px; }
                .order { border: 1px solid #ccc; padding: 15px; margin-bottom: 20px; border-radius: 8px; }
                h1 { color: #F97316; }
                h2 { border-bottom: 2px solid #eee; padding-bottom: 5px; }
                pre { background-color: #f4f4f4; padding: 10px; border-radius: 5px; white-space: pre-wrap; word-wrap: break-word; }
            </style>
            <h1>The Bihari Makhana - Orders</h1>
            <p>Found ${orders.length} orders.</p>
        `;

        orders.forEach(order => {
            html += `
                <div class="order">
                    <h2>Order #${order.id} - ${new Date(order.order_date).toLocaleString()}</h2>
                    <p><strong>Payment ID:</strong> ${order.payment_id}</p>
                    <h3>Customer Details:</h3>
                    <p><strong>Name:</strong> ${order.customer_name}</p>
                    <p><strong>Phone:</strong> ${order.phone}</p>
                    <p><strong>Address:</strong> ${order.address}</p>
                    <h3>Cart Items:</h3>
                    <pre>${JSON.stringify(order.cart_items, null, 2)}</pre>
                </div>
            `;
        });
        
        res.send(html);

    } catch (err) {
        console.error('Error fetching orders:', err);
        res.status(500).send('<h1>Error</h1><p>Could not fetch orders from the database.</p>');
    }
});


app.post('/checkout', async (req, res) => {
  const { cart, addressDetails, paymentId } = req.body;
  
  // Security Enhancement: Basic Input Validation
  if (!cart || typeof cart !== 'object' || Object.keys(cart).length === 0) {
      return res.status(400).json({ success: false, message: "Invalid cart data."});
  }
  if (!addressDetails || typeof addressDetails.name !== 'string' || typeof addressDetails.phone !== 'string' || typeof addressDetails.address !== 'string') {
      return res.status(400).json({ success: false, message: "Invalid address details."});
  }
  if (!paymentId || typeof paymentId !== 'string') {
      return res.status(400).json({ success: false, message: "Invalid payment ID."});
  }

  const insertQuery = `
    INSERT INTO orders (customer_name, phone, address, cart_items, payment_id)
    VALUES ($1, $2, $3, $4, $5);
  `;
  const values = [addressDetails.name, addressDetails.phone, addressDetails.address, cart, paymentId];

  try {
    const client = await pool.connect();
    await client.query(insertQuery, values);
    client.release();
    console.log('--- SUCCESS: ORDER SAVED TO DATABASE ---');
    res.json({ success: true, message: "Order saved successfully!" });
  } catch (err) {
    console.error('--- ERROR: FAILED TO SAVE ORDER TO DATABASE ---', err);
    res.status(500).json({ success: false, message: "Failed to save order." });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  setupDatabase();
});

