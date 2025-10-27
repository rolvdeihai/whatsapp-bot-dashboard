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
    
    // 🧠 MEMORY OPTIMIZATION: Use /tmp directory in production for ephemeral storage
    this.authPath = process.env.NODE_ENV === 'production' 
      ? '/tmp/whatsapp-auth' 
      : path.join(__dirname, '../auth');
    
    this.cacheDir = process.env.NODE_ENV === 'production'
      ? '/tmp/whatsapp-cache'
      : path.join(__dirname, '../group_cache');
    
    // 🧠 MEMORY OPTIMIZATION: Create directories safely
    this.ensureDirectoryExists(this.authPath);
    this.ensureDirectoryExists(this.cacheDir);
    
    // 🧠 MEMORY OPTIMIZATION: Global queue with limits
    this.processingQueue = [];
    this.isProcessing = false;
    this.currentProcessingRequest = null;
    this.maxQueueSize = 10; // Prevent unlimited queue growth
    
    // 🧠 MEMORY OPTIMIZATION: Rate limiting
    this.lastCommandTime = 0;
    this.minCommandInterval = 3000; // 3 seconds between commands
    
    // 🧠 MEMORY OPTIMIZATION: In-memory cache with limits (instead of file cache)
    this.groupCaches = new Map();
    this.maxCachedGroups = 5;
    this.maxCachedMessages = 30;
    
    // 🧠 MEMORY OPTIMIZATION: Start memory monitoring
    this.startMemoryMonitoring();
    
    this.loadActiveGroupsFromDisk();
    this.initializeBot();
  }

  // 🧹 NEW: Clear all temporary directories
  clearAllTmpDirectories() {
    console.log('🧹 Clearing all temporary directories...');
    
    const directoriesToClear = [
      this.authPath,
      this.cacheDir,
      path.join(__dirname, '../auth'),
      path.join(__dirname, '../group_cache'),
      path.join(__dirname, '../tmp'),
      '/tmp/whatsapp-auth',
      '/tmp/whatsapp-cache'
    ];
    
    directoriesToClear.forEach(dir => {
      try {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
          console.log(`✅ Cleared directory: ${dir}`);
        }
      } catch (error) {
        console.error(`❌ Failed to clear directory ${dir}:`, error);
      }
    });
    
    // Recreate essential directories
    this.ensureDirectoryExists(this.authPath);
    this.ensureDirectoryExists(this.cacheDir);
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
    // Check memory every 30 seconds
    setInterval(() => {
      this.checkMemoryUsage();
    }, 30000);
  }

  checkMemoryUsage() {
    const used = process.memoryUsage();
    const usedMB = Math.round(used.heapUsed / 1024 / 1024);
    const totalMB = Math.round(used.heapTotal / 1024 / 1024);
    
    console.log(`🧠 Memory usage: ${usedMB}MB / ${totalMB}MB`);
    
    // If memory usage is high, perform cleanup
    if (usedMB > 200) { // 200MB threshold for cleanup
      console.log('🔄 High memory usage detected, performing cleanup...');
      this.performMemoryCleanup();
    }
  }

  performMemoryCleanup() {
    console.log('🗑️ Performing memory cleanup...');
    
    // 🧠 MEMORY OPTIMIZATION: Trim processing queue
    if (this.processingQueue.length > this.maxQueueSize) {
      console.log(`🗑️ Trimming queue from ${this.processingQueue.length} to ${this.maxQueueSize} items`);
      this.processingQueue = this.processingQueue.slice(0, this.maxQueueSize);
    }
    
    // 🧠 MEMORY OPTIMIZATION: Clear old group caches
    if (this.groupCaches.size > this.maxCachedGroups) {
      const entries = Array.from(this.groupCaches.entries());
      // Keep only the most recent caches
      const recentEntries = entries.slice(-this.maxCachedGroups);
      this.groupCaches = new Map(recentEntries);
      console.log(`🗑️ Cleared group caches, keeping ${recentEntries.length} groups`);
    }
    
    // 🧠 MEMORY OPTIMIZATION: Force garbage collection if available
    if (global.gc) {
      global.gc();
      console.log('🗑️ Forced garbage collection');
    }
  }

  // 🧠 MEMORY OPTIMIZATION: Updated queue system with memory limits
  async addToQueue(message, chat, prompt, isSearchCommand) {
    // 🧠 MEMORY OPTIMIZATION: Rate limiting check
    const now = Date.now();
    if (now - this.lastCommandTime < this.minCommandInterval) {
      try {
        await message.reply('⏳ Please wait a few seconds before sending another command.');
      } catch (error) {
        console.error('Failed to send rate limit message:', error);
      }
      return;
    }

    // 🧠 MEMORY OPTIMIZATION: Queue size limit
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
      // 🧠 MEMORY OPTIMIZATION: Small delay between requests to prevent memory spikes
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
      // 🧠 MEMORY OPTIMIZATION: Fetch fewer messages (50 instead of 101)
      const waMessages = await chat.fetchMessages({ limit: 50 });

      const metadata = await chat.groupMetadata;
      if (!metadata || !metadata.participants) {
        console.log(`❌ [EXECUTE] No group metadata available.`);
        return;
      }

      // 🧠 MEMORY OPTIMIZATION: Process only first 30 participants
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

      // 🧠 MEMORY OPTIMIZATION: Format messages with length limits
      const formattedMessages = [];
      for (const msg of waMessages) {
        if (!msg.body || msg.fromMe) continue;
        const senderId = msg.author || msg.from;
        const userName = participantMap.get(senderId) || senderId.split('@')[0];
        formattedMessages.push({
          timestamp: new Date(msg.timestamp * 1000).toISOString().slice(0, 19).replace('T', ' '),
          user: userName,
          message: msg.body.substring(0, 300), // 🧠 Limit message length to 300 chars
          group_name: chat.name,
        });
      }

      // Sort and use only recent messages
      formattedMessages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const currentMessages = formattedMessages.slice(-30); // 🧠 Only last 30 messages

      // 🧠 MEMORY OPTIMIZATION: Use in-memory cache instead of file cache
      const newMessages = this.getNewMessagesFromMemory(chat.id._serialized, currentMessages);

      console.log(`🔔 [EXECUTE] Using ${newMessages.length} new messages (from ${currentMessages.length} total) for context`);

      // Get sender info
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
      // 🧠 MEMORY OPTIMIZATION: Limit cached messages
      const messagesToCache = currentMessages.slice(-this.maxCachedMessages);
      this.groupCaches.set(groupId, messagesToCache);
      return currentMessages;
    }

    // Create a map of cached messages for quick lookup
    const cachedMessageMap = new Map();
    cachedMessages.forEach(msg => {
      const key = `${msg.timestamp}_${msg.user}_${msg.message.substring(0, 50)}`;
      cachedMessageMap.set(key, true);
    });

    // Filter out messages that are already in cache
    const newMessages = currentMessages.filter(msg => {
      const key = `${msg.timestamp}_${msg.user}_${msg.message.substring(0, 50)}`;
      return !cachedMessageMap.has(key);
    });

    // 🧠 MEMORY OPTIMIZATION: Update cache with limited messages
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

  // 🧠 MEMORY OPTIMIZATION: Memory-efficient bot initialization
  async initializeBot() {
    if (this.isInitializing) {
      console.log('Bot is already initializing...');
      return;
    }

    this.isInitializing = true;
    
    try {
      console.log('🚀 Initializing bot with memory-optimized settings...');
      
      this.client = new Client({
        authStrategy: new LocalAuth({ 
          clientId: 'admin',
          dataPath: this.authPath
        }),
        puppeteer: {
          headless: true,
          // 🧠 MEMORY OPTIMIZATION: Aggressive memory-saving flags
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--single-process', // 🧠 Major memory reduction
            '--no-zygote',
            '--renderer-process-limit=1',
            '--max-old-space-size=128',
            '--memory-pressure-off'
          ],
          // 🧠 MEMORY OPTIMIZATION: Smaller viewport
          defaultViewport: { width: 800, height: 600 },
          ignoreHTTPSErrors: true,
        },
        // 🧠 MEMORY OPTIMIZATION: WhatsApp Web.js optimizations
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
        console.log('📱 New QR code generated - clearing old tmp directories...');
        
        // 🧹 NEW: Clear all tmp directories when new QR is generated
        this.clearAllTmpDirectories();
        
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

    this.client.on('ready', () => {
      console.log('✅ Bot connected successfully');
      this.emitToAllSockets('bot-status', { status: 'connected' });
      this.isInitializing = false;
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

  // 🧠 MEMORY OPTIMIZATION: Safe groups fetching with error handling
  async getGroups() {
    try {
      if (!this.client || !this.client.info) {
        console.log('⚠️ Bot client not ready — returning empty group list.');
        return [];
      }

      const chats = await this.client.getChats();
      if (!Array.isArray(chats)) {
        console.warn('⚠️ getChats() did not return an array, returning empty list.');
        return [];
      }

      // Filter group chats safely
      const groups = chats.filter(chat => {
        try {
          return !!chat && !!chat.isGroup;
        } catch (e) {
          console.warn('⚠️ Skipping invalid chat while filtering groups');
          return false;
        }
      });

      const groupData = groups.map(group => {
        try {
          const id = group && group.id && group.id._serialized ? group.id._serialized : null;
          const name = group && (group.name || group.subject) ? (group.name || group.subject) : 'Unknown Group';
          const participants = Array.isArray(group.participants) ? group.participants.length : 0;

          return { id, name, participants };
        } catch (err) {
          console.warn('⚠️ Error mapping group object');
          return { id: null, name: 'Unknown Group', participants: 0 };
        }
      }).filter(g => g.id);

      console.log(`📊 Found ${groupData.length} groups`);
      return groupData;

    } catch (error) {
      console.error('❌ Error fetching groups:', error);
      return [];
    }
  }

  setActiveGroups(groups) {
    this.activeGroups = groups;
    this.saveActiveGroupsToDisk();
    this.emitToAllSockets('active-groups-updated', { groups: groups });
    console.log('✅ Set active groups:', groups);
  }

  getBotStatus() {
    if (this.client && this.client.info) return 'connected';
    if (this.hasSession()) return 'session_exists';
    return 'disconnected';
  }

  // 🧠 MEMORY OPTIMIZATION: Efficient message handling
  async handleMessage(message) {
    // Quick early returns to save processing
    if (this.activeGroups.length === 0) return;
    
    const chat = await message.getChat();
    if (!chat.isGroup) return;
    
    if (!this.activeGroups.includes(chat.id._serialized)) return;

    // Check if message is too old (2 minutes)
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
          timeout: 2 * 60 * 1000, // 🧠 Reduced timeout to 2 minutes
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
          timeout: 3 * 60 * 1000, // 🧠 3 minutes for search
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

  // Socket management (unchanged but included for completeness)
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