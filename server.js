// This is the main file for our backend kitchen.
const express = require('express');
const cors = require('cors');

const app = express();
// Use the PORT environment variable Render provides, or 3001 for local testing
const port = process.env.PORT || 3001;

// Allow our website to talk to this backend
app.use(cors());
// Allow the backend to understand JSON data sent from the website
app.use(express.json());

// A simple test to see if the kitchen is open
app.get('/', (req, res) => {
  res.send('The Bihari Makhana backend is running!');
});

// THIS IS THE NEW PART: The "Waiter" that listens for orders
// When the website sends an order to '/checkout', this code will run
app.post('/checkout', (req, res) => {
  const cart = req.body.cart;
  console.log("--- NEW ORDER RECEIVED ---");
  console.log("Timestamp:", new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }));
  console.log("Items in cart:", cart);
  
  // Here, in the future, you would add code to save the order to a database
  // and process the payment with Razorpay.
  
  // For now, we just log the order and send a success message back.
  res.json({ success: true, message: "Order received successfully!" });
  console.log("--- ORDER PROCESSED ---");
});


// Start the server and listen for requests
app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});

