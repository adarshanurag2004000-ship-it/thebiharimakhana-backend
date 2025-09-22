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

// --- Security Middleware ---
app.use(helmet());

// Corrected whitelist including the backend's own address
const whitelist = ['https://inspiring-cranachan-69450a.netlify.app', 'https://www.inspiring-cranachan-69450a.netlify.app', 'https://thebiharimakhana-backend.onrender.com'];

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

// --- Middleware for parsing request bodies ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Database Connection ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// --- Database Setup Function ---
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
                cart_items JSONB NOT NULL,
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

const orderSchema = Joi.object({
    cart: Joi.object().required(),
    addressDetails: Joi.object({
        name: Joi.string().min(2).max(100).required(),
        phone: Joi.string().pattern(/^[0-9]{10,15}$/).required(),
        address: Joi.string().min(10).max(500).required()
    }).required(),
    razorpay_payment_id: Joi.string().required(),
    order_amount: Joi.number().positive().required()
});

// --- API Routes ---
app.get('/', (req, res) => {
    res.send('The Bihari Makhana Backend is running!');
});

app.get('/api/products', async (req, res
