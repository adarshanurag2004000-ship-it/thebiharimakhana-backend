const express = require('express');
const cors = require('cors');
const { Pool } = require('pg'); // Our new database tool

const app = express();
const PORT = process.env.PORT || 3001;

// Use CORS to allow our website to talk to the backend
app.use(cors());
app.use(express.json());

// Create a connection to our database using the secret key
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// A function to set up our database table the first time the server starts
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


// Main page of the backend
app.get('/', (req, res) => {
  res.send('The Bihari Makhana backend is running and connected to the database!');
});

// The checkout function, now upgraded to save to the database
app.post('/checkout', async (req, res) => {
  const { cart, addressDetails, paymentId } = req.body;

  console.log('--- NEW FULL ORDER RECEIVED ---');
  console.log(`Timestamp: ${new Date().toLocaleString()}`);
  console.log('--- Customer Details ---');
  console.log(`Name: ${addressDetails.name}`);
  console.log(`Phone: ${addressDetails.phone}`);
  console.log(`Address: ${addressDetails.address}`);
  console.log('--- Items in Cart ---');
  console.log(cart);
  console.log('--- Payment ID ---');
  console.log(paymentId);
  console.log('--- ATTEMPTING TO SAVE TO DATABASE ---');

  // The SQL command to insert the order into our filing cabinet
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
    console.error('--- ERROR: FAILED TO SAVE ORDER TO DATABASE ---');
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to save order." });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  setupDatabase(); // Set up the database as soon as the server starts
});

