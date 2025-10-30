// whatsapp-bot-dashboard/backend/src/botManager.js

import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import QRCode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class BotManager {
  constructor() {
    this.client = null;
    this.activeGroups = [];
    this.socketConnections = [];
    this.isInitializing = false;
    this.currentQrCode = null; // 🚀 ADD THIS - Missing property initialization
    
    // 🚀 PERFORMANCE: Optimized paths
    this.authPath = process.env.NODE_ENV === 'production' 
      ? '/tmp/whatsapp-auth' 
      : path.join(__dirname, '../auth');
    
    this.cacheDir = process.env.NODE_ENV === 'production'
      ? '/tmp/whatsapp-cache'
      : path.join(__dirname, '../group_cache');
    
    this.ensureDirectoryExists(this.authPath);
    this.ensureDirectoryExists(this.cacheDir);
    
    // 🚀 PERFORMANCE: Group caching with lazy loading
    this.groupsCache = {
      data: [],
      lastUpdated: 0,
      cacheDuration: 5 * 60 * 1000, // 5 minutes cache
      isUpdating: false
    };
    
    // 🧠 MEMORY OPTIMIZATION: Global queue with limits
    this.processingQueue = [];
    this.isProcessing = false;
    this.currentProcessingRequest = null;
    this.maxQueueSize = 10;
    
    // 🧠 MEMORY OPTIMIZATION: Rate limiting
    this.lastCommandTime = 0;
    this.minCommandInterval = 3000;
    
    // 🧠 MEMORY OPTIMIZATION: In-memory cache with limits
    this.groupCaches = new Map();
    this.maxCachedGroups = 5;
    this.maxCachedMessages = 30;
    
    this.startMemoryMonitoring();
    this.loadActiveGroupsFromDisk();
    this.initializeBot();
  }

  // 🧠 MEMORY OPTIMIZATION: Safe directory creation
  ensureDirectoryExists(dirPath) {
    try {
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        console.log(`📁 Created directory: ${dirPath}`);
      }
    } catch (error) {
      console.error(`❌ Failed to create directory ${dirPath}:`, error);
    }
  }

  // 🧠 MEMORY OPTIMIZATION: Memory monitoring system
  startMemoryMonitoring() {
    setInterval(() => {
      this.checkMemoryUsage();
    }, 30000);
  }

  checkMemoryUsage() {
    const used = process.memoryUsage();
    const usedMB = Math.round(used.heapUsed / 1024 / 1024);
    const totalMB = Math.round(used.heapTotal / 1024 / 1024);
    
    console.log(`🧠 Memory usage: ${usedMB}MB / ${totalMB}MB`);
    
    if (usedMB > 200) {
      console.log('🔄 High memory usage detected, performing cleanup...');
      this.performMemoryCleanup();
    }
  }

  performMemoryCleanup() {
    console.log('🗑️ Performing memory cleanup...');
    
    if (this.processingQueue.length > this.maxQueueSize) {
      console.log(`🗑️ Trimming queue from ${this.processingQueue.length} to ${this.maxQueueSize} items`);
      this.processingQueue = this.processingQueue.slice(0, this.maxQueueSize);
    }
    
    if (this.groupCaches.size > this.maxCachedGroups) {
      const entries = Array.from(this.groupCaches.entries());
      const recentEntries = entries.slice(-this.maxCachedGroups);
      this.groupCaches = new Map(recentEntries);
      console.log(`🗑️ Cleared group caches, keeping ${recentEntries.length} groups`);
    }
    
    if (global.gc) {
      global.gc();
      console.log('🗑️ Forced garbage collection');
    }
  }

  // 🚀 SIMPLIFIED: Remove all complex groups caching and processing
  async getGroups() {
    try {
      if (!this.client || !this.client.info) {
        console.log('⚠️ Bot client not ready');
        return [];
      }

      console.time('🕒 QuickGroupFetch');
      const chats = await this.client.getChats();
      console.timeEnd('🕒 QuickGroupFetch');

      if (!Array.isArray(chats)) {
        return [];
      }

      // 🚀 SIMPLIFIED: Only get basic group info - no participants, no metadata
      const groups = [];
      for (const chat of chats) {
        if (chat?.isGroup) {
          groups.push({
            id: chat.id?._serialized,
            name: chat.name || chat.subject || 'Unknown Group',
            // 🚀 MEMORY SAVING: No participant count, no metadata
          });
        }
        
        // 🚀 MEMORY SAVING: Limit to 100 groups maximum
        if (groups.length >= 100) break;
      }

      console.log(`✅ Quickly loaded ${groups.length} groups (basic info only)`);
      return groups;

    } catch (error) {
      console.error('❌ Error in quick groups fetch:', error);
      return [];
    }
  }

  // 🚀 NEW: Search groups by name (lightweight)
  async searchGroups(query) {
    try {
      if (!this.client || !this.client.info) {
        return [];
      }

      if (!query || query.length < 2) {
        return [];
      }

      console.log(`🔍 Searching groups for: "${query}"`);
      const chats = await this.client.getChats();
      const searchTerm = query.toLowerCase();

      const results = [];
      for (const chat of chats) {
        if (chat?.isGroup) {
          const name = (chat.name || chat.subject || '').toLowerCase();
          if (name.includes(searchTerm)) {
            results.push({
              id: chat.id?._serialized,
              name: chat.name || chat.subject || 'Unknown Group',
            });
            
            // 🚀 MEMORY SAVING: Limit search results
            if (results.length >= 20) break;
          }
        }
      }

      console.log(`✅ Found ${results.length} groups matching "${query}"`);
      return results;

    } catch (error) {
      console.error('❌ Error searching groups:', error);
      return [];
    }
  }

  // 🚀 NEW: Get only saved groups (very lightweight)
  async getSavedGroups(groupIds) {
    try {
      if (!this.client || !this.client.info || !Array.isArray(groupIds)) {
        return [];
      }

      if (groupIds.length === 0) {
        return [];
      }

      console.log(`📁 Loading ${groupIds.length} saved groups`);
      const chats = await this.client.getChats();
      
      const savedGroups = [];
      for (const groupId of groupIds) {
        const chat = chats.find(c => c?.isGroup && c.id?._serialized === groupId);
        if (chat) {
          savedGroups.push({
            id: groupId,
            name: chat.name || chat.subject || 'Unknown Group',
          });
        }
        
        // 🚀 MEMORY SAVING: Process in small batches
        if (savedGroups.length % 10 === 0) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }

      console.log(`✅ Loaded ${savedGroups.length} saved groups`);
      return savedGroups;

    } catch (error) {
      console.error('❌ Error loading saved groups:', error);
      return [];
    }
  }

  // 🚀 PERFORMANCE: Refresh groups cache
  async refreshGroups() {
    console.log('🔄 Manually refreshing groups cache...');
    return await this.getGroups(true);
  }

  // 🧠 MEMORY OPTIMIZATION: Updated queue system with memory limits
  async addToQueue(message, chat, prompt, isSearchCommand) {
    const now = Date.now();
    if (now - this.lastCommandTime < this.minCommandInterval) {
      try {
        await message.reply('⏳ Please wait a few seconds before sending another command.');
      } catch (error) {
        console.error('Failed to send rate limit message:', error);
      }
      return;
    }

    if (this.processingQueue.length >= this.maxQueueSize) {
      try {
        await message.reply('❌ *Queue is full!*\n\nPlease try again later when the queue has space.');
      } catch (error) {
        console.error('Failed to send queue full message:', error);
      }
      return;
    }

    const request = {
      message,
      chat,
      prompt,
      isSearchCommand,
      timestamp: Date.now(),
      groupId: chat.id._serialized,
      groupName: chat.name
    };

    this.processingQueue.push(request);
    const queuePosition = this.processingQueue.length;
    console.log(`📝 [QUEUE] Added request. Position: ${queuePosition}, Group: ${chat.name}`);

    if (!this.isProcessing) {
      this.processQueue();
    } else {
      const waitMessage = `⏳ *Your request has been added to the queue.*\n\n` +
                         `📊 *Position in queue:* ${queuePosition}\n` +
                         `⏰ *Estimated wait time:* ${queuePosition * 1} minute(s)\n\n` +
                         `_Only one message can be processed at a time across all groups._`;
      
      try {
        await message.reply(waitMessage);
      } catch (error) {
        console.error(`❌ [QUEUE] Failed to send queue notification:`, error);
      }
    }

    this.lastCommandTime = now;
  }

  async processQueue() {
    if (this.processingQueue.length === 0) {
      this.isProcessing = false;
      this.currentProcessingRequest = null;
      return;
    }

    this.isProcessing = true;
    const request = this.processingQueue[0];
    this.currentProcessingRequest = request;
    
    console.log(`🔄 [QUEUE] Processing request. Group: ${request.groupName}, Remaining: ${this.processingQueue.length - 1}`);

    try {
      if (this.processingQueue.length > 1) {
        try {
          const startMessage = `🚀 *Starting to process your request...*\n\n` +
                              `📝 _Please wait while I generate your response..._`;
          await request.message.reply(startMessage);
        } catch (notifyError) {
          console.error('Failed to send start notification:', notifyError);
        }
      }

      await this.executeCommand(request.message, request.chat, request.prompt, request.isSearchCommand);
      
      this.processingQueue.shift();
      this.currentProcessingRequest = null;
      console.log(`✅ [QUEUE] Request completed. Queue length: ${this.processingQueue.length}`);
      
    } catch (error) {
      console.error(`❌ [QUEUE] Error processing request for group ${request.groupName}:`, error);
      this.processingQueue.shift();
      this.currentProcessingRequest = null;
      
      try {
        await request.message.reply('❌ Sorry, there was an error processing your request. Please try again.');
      } catch (replyError) {
        console.error('Failed to send error notification:', replyError);
      }
    } finally {
      if (this.processingQueue.length > 0) {
        setTimeout(() => {
          this.processQueue();
        }, 1000);
      } else {
        this.isProcessing = false;
        this.currentProcessingRequest = null;
      }
    }
  }

  // 🧠 MEMORY OPTIMIZATION: Optimized command execution with reduced data
  async executeCommand(message, chat, prompt, isSearchCommand) {
    console.log(`🔔 [EXECUTE] Processing command: "${prompt.substring(0, 50)}..."`);
    
    try {
      const waMessages = await chat.fetchMessages({ limit: 50 });

      const metadata = await chat.groupMetadata;
      if (!metadata || !metadata.participants) {
        console.log(`❌ [EXECUTE] No group metadata available.`);
        return;
      }

      const participantMap = new Map();
      const participantsToProcess = metadata.participants.slice(0, 30);
      
      for (const participant of participantsToProcess) {
        try {
          const contact = await this.client.getContactById(participant.id);
          const name = contact.pushname || contact.verifiedName || contact.number || participant.id._serialized.split('@')[0];
          participantMap.set(participant.id._serialized, name);
        } catch (err) {
          participantMap.set(participant.id._serialized, participant.id._serialized.split('@')[0]);
        }
      }

      const formattedMessages = [];
      for (const msg of waMessages) {
        if (!msg.body || msg.fromMe) continue;
        const senderId = msg.author || msg.from;
        const userName = participantMap.get(senderId) || senderId.split('@')[0];
        formattedMessages.push({
          timestamp: new Date(msg.timestamp * 1000).toISOString().slice(0, 19).replace('T', ' '),
          user: userName,
          message: msg.body.substring(0, 300),
          group_name: chat.name,
        });
      }

      formattedMessages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const currentMessages = formattedMessages.slice(-30);

      const newMessages = this.getNewMessagesFromMemory(chat.id._serialized, currentMessages);

      console.log(`🔔 [EXECUTE] Using ${newMessages.length} new messages (from ${currentMessages.length} total) for context`);

      const contact = await message.getContact();
      const phoneNumber = (message.author || message.from).split('@')[0];
      const displayName = contact.pushname || contact.verifiedName || contact.number || phoneNumber;
      const senderFormatted = `${phoneNumber} (${displayName})`;

      let response;
      if (isSearchCommand) {
        response = await this.callExternalAPISearch({
          messages: newMessages,
          prompt: prompt,
          groupName: chat.name,
          sender: senderFormatted,
          timestamp: new Date().toISOString(),
          totalMessageCount: currentMessages.length,
          newMessageCount: newMessages.length
        });
      } else {
        response = await this.callExternalAPI({
          messages: newMessages,
          prompt: prompt,
          groupName: chat.name,
          sender: senderFormatted,
          timestamp: new Date().toISOString(),
          totalMessageCount: currentMessages.length,
          newMessageCount: newMessages.length
        });
      }
      
      console.log(`✅ [EXECUTE] API response received`);
      await message.reply(response);
      console.log(`✅ [EXECUTE] Reply sent successfully.`);

    } catch (error) {
      console.error(`❌ [EXECUTE] Error in executeCommand:`, error);
      try {
        await message.reply('❌ Sorry, there was an error processing your request. Please try again.');
      } catch (replyError) {
        console.error('Failed to send error reply:', replyError);
      }
    }
  }

  // 🧠 MEMORY OPTIMIZATION: In-memory cache instead of file cache
  getNewMessagesFromMemory(groupId, currentMessages) {
    const cachedMessages = this.groupCaches.get(groupId) || [];
    
    if (cachedMessages.length === 0) {
      const messagesToCache = currentMessages.slice(-this.maxCachedMessages);
      this.groupCaches.set(groupId, messagesToCache);
      return currentMessages;
    }

    const cachedMessageMap = new Map();
    cachedMessages.forEach(msg => {
      const key = `${msg.timestamp}_${msg.user}_${msg.message.substring(0, 50)}`;
      cachedMessageMap.set(key, true);
    });

    const newMessages = currentMessages.filter(msg => {
      const key = `${msg.timestamp}_${msg.user}_${msg.message.substring(0, 50)}`;
      return !cachedMessageMap.has(key);
    });

    const updatedCache = currentMessages.slice(-this.maxCachedMessages);
    this.groupCaches.set(groupId, updatedCache);

    console.log(`🔍 [CACHE] Group ${groupId}: ${cachedMessages.length} cached, ${currentMessages.length} current, ${newMessages.length} new messages`);

    return newMessages;
  }

  // 🧠 MEMORY OPTIMIZATION: Updated session management
  hasSession() {
    try {
      if (!fs.existsSync(this.authPath)) {
        return false;
      }
      
      const files = fs.readdirSync(this.authPath);
      console.log(`Session check in ${this.authPath}:`, files);
      
      const hasSessionFiles = files.some(file => 
        file.includes('session') || 
        file.endsWith('.json') || 
        file === 'wwebjs.browserid' ||
        file === 'wwebjs.session.json'
      );
      
      return hasSessionFiles;
    } catch (error) {
      console.error('Error checking session:', error);
      return false;
    }
  }

  // 🚀 FIX: Add getBotStatus method here (moved up in the class)
  getBotStatus() {
    if (this.client && this.client.info) return 'connected';
    if (this.hasSession()) return 'session_exists';
    return 'disconnected';
  }

  // Save/Load active groups
  saveActiveGroupsToDisk() {
    try {
      const dataPath = path.join(this.authPath, 'activeGroups.json');
      fs.writeFileSync(dataPath, JSON.stringify(this.activeGroups, null, 2));
      console.log('💾 Active groups saved to disk:', this.activeGroups);
    } catch (error) {
      console.error('❌ Error saving active groups:', error);
    }
  }

  loadActiveGroupsFromDisk() {
    try {
      const dataPath = path.join(this.authPath, 'activeGroups.json');
      if (fs.existsSync(dataPath)) {
        const data = fs.readFileSync(dataPath, 'utf8');
        this.activeGroups = JSON.parse(data);
        console.log('📁 Active groups loaded from disk:', this.activeGroups);
      }
    } catch (error) {
      console.error('❌ Error loading active groups:', error);
      this.activeGroups = [];
    }
  }

  // 🚀 PERFORMANCE: Optimized bot initialization
  async initializeBot() {
    if (this.isInitializing) {
      console.log('Bot is already initializing...');
      return;
    }

    this.isInitializing = true;
    
    try {
      console.log('🚀 Initializing bot with performance optimizations...');
      
      this.client = new Client({
        authStrategy: new LocalAuth({ 
          clientId: 'admin',
          dataPath: this.authPath
        }),
        // In your BotManager constructor, update the puppeteer section:
        puppeteer: {
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--max-old-space-size=512'
          ],
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined, // Use system Chromium
          ignoreDefaultArgs: ['--disable-extensions'],
        },
        takeoverOnConflict: false,
        takeoverTimeoutMs: 0,
        restartOnAuthFail: false,
        qrMaxRetries: 3,
      });

      this.setupClientEvents();
      await this.client.initialize();
      
    } catch (error) {
      console.error('❌ Error initializing bot:', error);
      this.emitToAllSockets('bot-error', { error: error.message });
      this.isInitializing = false;
    }
  }

  setupClientEvents() {
    if (!this.client) return;

    this.client.on('qr', async (qr) => {
      try {
        const qrImage = await QRCode.toDataURL(qr);
        this.currentQrCode = qrImage;
        this.emitToAllSockets('qr-code', { qr: qrImage });
        this.emitToAllSockets('bot-status', { status: 'scan_qr' });
        console.log('📱 QR code generated and sent to frontend');
      } catch (error) {
        console.error('❌ Error generating QR code:', error);
        this.emitToAllSockets('bot-error', { error: 'Failed to generate QR code' });
      }
    });

    this.client.on('ready', async () => {
      console.log('✅ Bot connected successfully');
      this.emitToAllSockets('bot-status', { status: 'connected' });
      this.isInitializing = false;
      
      // 🚀 PERFORMANCE: Pre-load groups in background
      setTimeout(async () => {
        console.log('🔄 Pre-loading groups cache in background...');
        try {
          await this.getGroups(true);
          console.log('✅ Groups cache pre-loaded successfully');
        } catch (error) {
          console.error('❌ Background groups pre-load failed:', error);
        }
      }, 2000);
    });

    this.client.on('authenticated', () => {
      console.log('🔐 Bot authenticated');
      this.emitToAllSockets('bot-status', { status: 'authenticated' });
    });

    this.client.on('auth_failure', (error) => {
      console.error('❌ Bot auth failed:', error);
      this.emitToAllSockets('bot-error', { error: 'Authentication failed' });
      this.isInitializing = false;
    });

    this.client.on('disconnected', (reason) => {
      console.log('🔌 Bot disconnected:', reason);
      this.emitToAllSockets('bot-status', { status: 'disconnected' });
      this.client = null;
      this.isProcessing = false;
      
      // 🧠 MEMORY OPTIMIZATION: Clear everything on disconnect
      this.groupsCache.data = [];
      this.groupsCache.lastUpdated = 0;
      this.processingQueue = [];
      this.currentProcessingRequest = null;
      this.groupCaches.clear();
      
      setTimeout(() => {
        this.initializeBot();
      }, 5000);
    });

    this.client.on('message', async (message) => {
      await this.handleMessage(message);
    });
  }

  // 🧠 MEMORY OPTIMIZATION: Safe bot shutdown with cleanup
  stopBot() {
    console.log('🛑 Stopping bot and cleaning up memory...');
    
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    
    this.isInitializing = false;
    
    // 🧠 MEMORY OPTIMIZATION: Clear all memory-intensive data
    this.processingQueue = [];
    this.isProcessing = false;
    this.currentProcessingRequest = null;
    this.groupCaches.clear();
    
    console.log('✅ Bot stopped and memory cleaned up');
  }

  setActiveGroups(groups) {
    this.activeGroups = groups;
    this.saveActiveGroupsToDisk();
    this.emitToAllSockets('active-groups-updated', { groups: groups });
    console.log('✅ Set active groups:', groups);
  }

  // 🧠 MEMORY OPTIMIZATION: Efficient message handling
  async handleMessage(message) {
    if (this.activeGroups.length === 0) return;
    
    const chat = await message.getChat();
    if (!chat.isGroup) return;
    
    if (!this.activeGroups.includes(chat.id._serialized)) return;

    const messageTimestamp = message.timestamp;
    const twoMinutesAgo = Date.now() / 1000 - 120;
    if (messageTimestamp < twoMinutesAgo) return;

    const messageText = message.body;
    
    if (this.isBotCommand(messageText)) {
      const isSearchCommand = messageText.toLowerCase().includes('!ai_search');
      const prompt = this.extractPrompt(message.body, isSearchCommand);
      
      if (!prompt) return;

      await this.addToQueue(message, chat, prompt, isSearchCommand);
    }
  }

  isBotCommand(messageText) {
    const commands = ['!bot', '!ai', '@bot', 'bot,', '!ai_search'];
    return commands.some(cmd => messageText.toLowerCase().includes(cmd));
  }

  // 🧠 MEMORY OPTIMIZATION: External API calls with memory awareness
  async callExternalAPI(payload) {
    const apiUrl = process.env.API_ENDPOINT;
    const generateEndpoint = `${apiUrl}/generate_real_time`;
    
    console.log(`🔔 [API] Calling: ${generateEndpoint}`);
    console.log(`📊 [API] Sending ${payload.messages.length} messages`);

    try {
      const response = await axios.post(
        generateEndpoint,
        {
          messages: payload.messages,
          prompt: payload.prompt,
          group_name: payload.groupName,
          cache_info: {
            total_messages: payload.totalMessageCount,
            new_messages: payload.newMessageCount,
            has_cached_context: payload.totalMessageCount > payload.newMessageCount
          }
        },
        {
          timeout: 10 * 60 * 1000,
          headers: { 'Content-Type': 'application/json' },
        }
      );

      const data = response.data;
      return (
        data.response ||
        data.answer ||
        data.text ||
        'I received your message but cannot generate a response right now.'
      );

    } catch (error) {
      console.error('❌ API call failed:', error.message);
      return 'Sorry, there was an error processing your request. Please try again later.';
    }
  }

  async callExternalAPISearch(payload) {
    const apiUrl = process.env.API_ENDPOINT;
    const generateEndpoint = `${apiUrl}/generate_realtime_search`;

    console.log(`🔔 [API-SEARCH] Calling: ${generateEndpoint}`);

    try {
      const response = await axios.post(
        generateEndpoint,
        {
          messages: payload.messages,
          prompt: payload.prompt,
          group_name: payload.groupName,
          enable_search: true,
          max_search_results: 3,
          cache_info: {
            total_messages: payload.totalMessageCount,
            new_messages: payload.newMessageCount,
            has_cached_context: payload.totalMessageCount > payload.newMessageCount
          }
        },
        {
          timeout: 10 * 60 * 1000,
          headers: { 'Content-Type': 'application/json' },
        }
      );

      const data = response.data;
      
      let responseText = data.response ||
        data.answer ||
        data.text ||
        'I received your message but cannot generate a response right now.';
      
      if (data.search_info && data.search_info.search_query) {
        responseText += `\n\n🔍 *Search Info:* Queried "${data.search_info.search_query}"`;
        if (data.search_info.articles_found) {
          responseText += `, found ${data.search_info.articles_found} articles`;
        }
      }
      
      return responseText;

    } catch (error) {
      console.error('❌ Search API call failed:', error.message);
      return 'Sorry, the search request failed. Please try again later or use !ai for a faster response.';
    }
  }

  extractPrompt(messageText, isSearchCommand = false) {
    if (isSearchCommand) {
      return messageText.replace(/(!ai_search)\s*/i, '').trim();
    } else {
      return messageText.replace(/(!bot|!ai|@bot|bot,)\s*/i, '').trim();
    }
  }

  // 🚀 PERFORMANCE: Add method to clear groups cache
  clearGroupsCache() {
    this.groupsCache.data = [];
    this.groupsCache.lastUpdated = 0;
    console.log('🗑️ Groups cache cleared');
  }

  // Socket management
  addSocketConnection(socket) {
    this.socketConnections.push(socket);
    console.log('🔌 Socket connection added. Total connections:', this.socketConnections.length);
    
    this.emitToAllSockets('bot-status', { 
      status: this.getBotStatus(),
      qrCode: this.currentQrCode
    });
    
    this.emitToAllSockets('active-groups-updated', { groups: this.activeGroups });
  }

  removeSocketConnection(socket) {
    this.socketConnections = this.socketConnections.filter(s => s !== socket);
    console.log('🔌 Socket connection removed. Total connections:', this.socketConnections.length);
  }

  emitToAllSockets(event, data) {
    this.socketConnections.forEach(socket => {
      try {
        socket.emit(event, data);
      } catch (error) {
        console.error('❌ Error emitting to socket:', error);
      }
    });
  }
}

export default BotManager;