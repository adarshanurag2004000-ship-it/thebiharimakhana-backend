// This is the main file for our backend kitchen.
const express = require('express');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// Allow our website to talk to this backend
app.use(cors());
app.use(express.json());

// A simple test to see if the kitchen is open
app.get('/', (req, res) => {
  res.send('The Bihari Makhana backend is running!');
});

// Start the server and listen for requests
app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});

