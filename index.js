/**
 * Civil Security Voice AI Chatbot Server
 * 
 * This is the main entry point for the Civil Security Voice AI Chatbot server.
 * It sets up the Express server, Socket.IO for real-time communication,
 * and initializes the Civil Security chatbot.
 */

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

// Import the Civil Security Manager
const { initializeCivilSecurityNamespace } = require('./utils/botUtilities/CivilSecurityManager');

// Create Express app
const app = express();

// Configure middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.IO
const io = socketIO(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Initialize Civil Security namespace
const civilSecurityNamespace = io.of('/civil-security');
initializeCivilSecurityNamespace(civilSecurityNamespace);

// Define routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the server
const PORT = process.env.CIVIL_SECURITY_PORT || 3001;
server.listen(PORT, () => {
  console.log(`Civil Security Voice AI Chatbot server running on port ${PORT}`);
  console.log(`Access the chatbot at http://localhost:${PORT}`);
});

