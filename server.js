// This is the main file for our backend kitchen.
const express = require('express');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3001;

// Allow our website to talk to this backend
app.use(cors());
// Allow the backend to understand JSON data sent from the website
app.use(express.json());

// A simple test to see if the kitchen is open
app.get('/', (req, res) => {
  res.send('The Bihari Makhana backend is running!');
});

// The "Waiter" that listens for orders AFTER payment
app.post('/checkout', (req, res) => {
  // NOW we expect the cart, address, AND the payment ID from Razorpay
  const { cart, addressDetails, paymentId } = req.body; 
  
  console.log("--- NEW PAYMENT & ORDER RECEIVED ---");
  console.log("Timestamp:", new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }));
  console.log("Razorpay Payment ID:", paymentId);
  console.log("--- Customer Details ---");
  console.log("Name:", addressDetails.name);
  console.log("Phone:", addressDetails.phone);
  console.log("Address:", addressDetails.address);
  console.log("--- Items in Cart ---");
  console.log(cart);
  
  // ================== IMPORTANT SECURITY STEP ==================
  // In a real production system, you would add code here to:
  // 1. Get your Razorpay Key Secret from a secure place.
  // 2. Use that secret to verify the payment signature sent by Razorpay.
  // 3. If the signature is valid, save the order to your database.
  // 4. If the signature is invalid, you would reject the order.
  // =============================================================
  
  res.json({ success: true, message: "Order and Payment ID received successfully!" });
  console.log("--- ORDER PROCESSED ---");
});


// Start the server and listen for requests
app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});

