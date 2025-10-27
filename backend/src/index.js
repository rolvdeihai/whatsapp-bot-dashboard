//backend/src/index.js

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
    origin: ['https://baby-ai.vercel.app', 'http://localhost:3000'],
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

const botManager = new BotManager();

// API Routes (no userId needed)
app.get('/api/groups', async (req, res) => {
  try {
    console.log(`[${new Date().toISOString()}] GET /api/groups from ${req.ip} (origin: ${req.headers.origin})`);
    const groups = await botManager.getGroups();
    // ensure valid JSON
    if (!Array.isArray(groups)) {
      console.warn('getGroups returned non-array, converting to empty array');
      return res.json([]);
    }
    return res.json(groups);
  } catch (error) {
    // Log stacktrace (global handlers will also capture this)
    console.error('Error in /api/groups route:', error && error.stack ? error.stack : error);
    return res.status(500).json({ error: 'Internal server error fetching groups' });
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

// 🚀 PERFORMANCE: Quick groups preview (fast loading)
app.get('/api/groups/preview', async (req, res) => {
  try {
    console.log(`[${new Date().toISOString()}] GET /api/groups/preview`);
    const groups = await botManager.getGroupsPreview();
    return res.json(groups);
  } catch (error) {
    console.error('Error in /api/groups/preview:', error);
    return res.status(500).json({ error: 'Internal server error fetching groups preview' });
  }
});

// 🚀 PERFORMANCE: Get detailed info for specific groups only
app.post('/api/groups/details', async (req, res) => {
  try {
    const { groupIds } = req.body;
    console.log(`[${new Date().toISOString()}] POST /api/groups/details for ${groupIds?.length || 0} groups`);
    
    if (!Array.isArray(groupIds)) {
      return res.status(400).json({ error: 'groupIds must be an array' });
    }

    const groups = await botManager.getGroupDetails(groupIds);
    return res.json(groups);
  } catch (error) {
    console.error('Error in /api/groups/details:', error);
    return res.status(500).json({ error: 'Internal server error fetching group details' });
  }
});

// 🚀 PERFORMANCE: Refresh groups cache
app.post('/api/groups/refresh', async (req, res) => {
  try {
    console.log(`[${new Date().toISOString()}] POST /api/groups/refresh`);
    const groups = await botManager.refreshGroups();
    return res.json(groups);
  } catch (error) {
    console.error('Error in /api/groups/refresh:', error);
    return res.status(500).json({ error: 'Internal server error refreshing groups' });
  }
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