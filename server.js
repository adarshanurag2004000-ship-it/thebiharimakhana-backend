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

// The "Waiter" that listens for orders
app.post('/checkout', (req, res) => {
  // NOW we expect both the cart AND the address details
  const { cart, addressDetails } = req.body; 
  
  console.log("--- NEW FULL ORDER RECEIVED ---");
  console.log("Timestamp:", new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }));
  console.log("--- Customer Details ---");
  console.log("Name:", addressDetails.name);
  console.log("Phone:", addressDetails.phone);
  console.log("Address:", addressDetails.address);
  console.log("--- Items in Cart ---");
  console.log(cart);
  
  // In the future, you would save all this to a database.
  
  res.json({ success: true, message: "Order received successfully!" });
  console.log("--- ORDER PROCESSED ---");
});


// Start the server and listen for requests
app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});

