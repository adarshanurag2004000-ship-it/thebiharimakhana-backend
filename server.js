const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const Joi = require('joi');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const he = require('he');
require('dotenv').config();
const sgMail = require('@sendgrid/mail');

// Set SendGrid API Key
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
        
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY, email VARCHAR(255) UNIQUE NOT NULL, firebase_uid VARCHAR(255) UNIQUE NOT NULL,
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
// ... (Your other routes like /, /api/products, /api/calculate-total are unchanged)

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

        // --- SEND CONFIRMATION EMAIL ---
        await sendOrderConfirmationEmail(user.email, addressDetails.name, newOrder, cart, subtotal, shippingCost, totalAmount);
        
        res.json({ success: true, message: 'Order placed successfully!' });

    } catch (err) {
        console.error('Error during checkout:', err);
        res.status(500).json({ success: false, message: 'An internal server error occurred.' });
    }
});

// ... (Your other API routes like /api/user-login, /api/my-orders are unchanged)

// --- Email Sending Function ---
async function sendOrderConfirmationEmail(customerEmail, customerName, order, cart, subtotal, shippingCost, total) {
    const orderDate = new Date(order.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const itemsHtml = Object.keys(cart).map(name => {
        const item = cart[name];
        const displayName = name.charAt(0).toUpperCase() + name.slice(1);
        return `<tr>
            <td style="padding: 10px; border-bottom: 1px solid #ddd;">${displayName} (x${item.quantity})</td>
            <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right;">₹${(item.price * item.quantity).toFixed(2)}</td>
        </tr>`;
    }).join('');

    const emailHtml = `
      <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #ddd; padding: 20px;">
        <h1 style="color: #F97316; text-align: center;">Thank You For Your Order!</h1>
        <p>Hi ${he.encode(customerName)},</p>
        <p>We've received your order and will process it shortly. Here are the details:</p>
        <div style="border: 1px solid #eee; padding: 15px; margin: 20px 0;">
          <h2 style="margin-top: 0;">Invoice #${order.id}</h2>
          <p><strong>Order Date:</strong> ${orderDate}</p>
          <table style="width: 100%; border-collapse: collapse;">
            <thead>
              <tr>
                <th style="padding: 10px; border-bottom: 2px solid #ddd; text-align: left;">Item</th>
                <th style="padding: 10px; border-bottom: 2px solid #ddd; text-align: right;">Price</th>
              </tr>
            </thead>
            <tbody>
              ${itemsHtml}
              <tr>
                <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right;">Subtotal:</td>
                <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right;">₹${subtotal.toFixed(2)}</td>
              </tr>
              <tr>
                <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right;">Shipping:</td>
                <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right;">₹${shippingCost.toFixed(2)}</td>
              </tr>
              <tr>
                <td style="padding: 10px; font-weight: bold; text-align: right;">Total:</td>
                <td style="padding: 10px; font-weight: bold; text-align: right;">₹${total.toFixed(2)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p style="font-size: 12px; color: #777; text-align: center;">
          This is an automated mail, please do not reply. For any questions, contact us at 
          <a href="mailto:thebiharimakhana@gmail.com">thebiharimakhana@gmail.com</a>.
        </p>
      </div>
    `;

    const msg = {
        to: customerEmail,
        from: 'thebiharimakhana@gmail.com', // This MUST be your verified SendGrid sender
        subject: `Your The Bihari Makhana Order #${order.id} is Confirmed!`,
        html: emailHtml,
    };

    try {
        await sgMail.send(msg);
        console.log('Confirmation email sent to', customerEmail);
    } catch (error) {
        console.error('Error sending confirmation email:', error);
    }
}


// --- Admin Routes ---
// (Your admin routes are unchanged)

// Final boilerplate
app.listen(port, () => {
    console.log(`Server is listening on port ${port}`);
    setupDatabase();
});
