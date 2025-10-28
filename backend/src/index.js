// whatsapp-bot-dashboard/backend/src/index.js

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import BotManager from './botManager.js';

// === Global error handlers (very important for debugging crashes) ===
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err && err.stack ? err.stack : err);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: ['https://baby-ai.vercel.app', 'http://localhost:3000', 'https://whatsapp-bot-dashboard-dnakfvf8r-jethro-elijah-lims-projects.vercel.app/', 'https://arturo-nonclarified-chivalrously.ngrok-free.dev'],
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// ✅ Allow both your deployed frontend and local dev frontend
const allowedOrigins = [
  'https://baby-ai.vercel.app',   // production frontend
  'http://localhost:3000',        // local dev
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile or curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      console.warn('Blocked CORS request from origin:', origin);
      return callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true,
}));

// 🚀 CRITICAL FIX: Add JSON body parser middleware
app.use(express.json());

const botManager = new BotManager();

// API Routes (no userId needed)
// 🚀 SIMPLIFIED: Quick groups endpoint
app.get('/api/groups', async (req, res) => {
  try {
    console.log(`[${new Date().toISOString()}] GET /api/groups (quick)`);
    const groups = await botManager.getGroups();
    return res.json(groups);
  } catch (error) {
    console.error('Error in /api/groups:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 🚀 NEW: Search groups endpoint
app.get('/api/groups/search', async (req, res) => {
  try {
    const { q } = req.query;
    console.log(`[${new Date().toISOString()}] GET /api/groups/search?q=${q}`);
    
    if (!q || q.length < 2) {
      return res.json([]);
    }

    const groups = await botManager.searchGroups(q);
    return res.json(groups);
  } catch (error) {
    console.error('Error in /api/groups/search:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 🚀 NEW: Get saved groups only
app.post('/api/groups/saved', async (req, res) => {
  try {
    const { groupIds } = req.body;
    console.log(`[${new Date().toISOString()}] POST /api/groups/saved for ${groupIds?.length || 0} groups`);
    
    if (!Array.isArray(groupIds)) {
      return res.status(400).json({ error: 'groupIds must be an array' });
    }

    const groups = await botManager.getSavedGroups(groupIds);
    return res.json(groups);
  } catch (error) {
    console.error('Error in /api/groups/saved:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Keep your existing active-groups endpoint
app.post('/api/active-groups', async (req, res) => {
  try {
    const { groups } = req.body;
    console.log('Setting active groups:', groups);
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