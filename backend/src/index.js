//backend/src/index.js

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import BotManager from './botManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../../build')));

const botManager = new BotManager();

// API Routes (no userId needed)
app.get('/api/groups', async (req, res) => {
  try {
    console.log('Fetching groups for admin bot');
    const groups = await botManager.getGroups();
    res.json(groups || []);
  } catch (error) {
    console.error('Error fetching groups:', error);
    res.status(500).json({ error: error.message || "Internal server error fetching groups" });
  }
});

app.post('/api/active-groups', async (req, res) => {
  try {
    const { groups } = req.body;
    console.log('Setting active groups for admin bot:', groups);
    botManager.setActiveGroups(groups);
    res.json({ success: true });
  } catch (error) {
    console.error('Error setting active groups:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/bot-status', (req, res) => {
  console.log('Checking bot status for admin bot');
  const status = botManager.getBotStatus();
  res.json({ status });
});

// Serve React app for non-API routes
app.get(/^(?!\/api).*/, (req, res) => {
  console.log(`Serving React app for route: ${req.originalUrl}`);
  res.sendFile(path.join(__dirname, '../../build', 'index.html'));
});

// Socket.io for real-time communication
io.on('connection', (socket) => {
  console.log('Admin client connected:', socket.id);
  
  // Add socket to bot manager
  botManager.addSocketConnection(socket);
  
  socket.on('start-bot', async () => {
    console.log('Manual bot start requested');
    await botManager.initializeBot();
  });
  
  socket.on('stop-bot', () => {
    console.log('Manual bot stop requested');
    botManager.stopBot();
  });
  
  socket.on('disconnect', () => {
    console.log('Admin client disconnected:', socket.id);
    botManager.removeSocketConnection(socket);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});