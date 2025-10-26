import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import { chromium } from 'playwright';
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
    this.browserContext = null;
    this.activeGroups = [];
    this.socketConnections = [];
    this.isInitializing = false;
    
    // Global Request queue system
    this.processingQueue = [];
    this.isProcessing = false;
    this.currentProcessingRequest = null;
    
    // Session recovery and keep-alive
    this.keepAliveInterval = null;
    this.recoveryInProgress = false;
    this.initializationStartTime = null;
    this.isFullyReady = false;
    
    // Initialization control properties
    this.initializationTimeout = null;
    this.maxInitializationTime = 120000;
    this.currentQrCode = null;
    
    // 🆕 Use /tmp directory for Hugging Face Spaces compatibility
    this.baseTempDir = '/tmp/whatsapp-bot';
    this.cacheDir = path.join(this.baseTempDir, 'group_cache');
    this.authDir = path.join(this.baseTempDir, 'auth');
    
    this.loadActiveGroupsFromDisk();
    
    // Create cache and auth directories if they don't exist
    this.ensureDirectoriesExist();
    
    // Auto-initialize bot when server starts
    this.initializeBot();
  }

  // 🆕 Ensure directories exist with proper permissions
  ensureDirectoriesExist() {
    try {
      // Create base temp directory
      if (!fs.existsSync(this.baseTempDir)) {
        fs.mkdirSync(this.baseTempDir, { recursive: true, mode: 0o755 });
      }
      
      // Create cache directory
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true, mode: 0o755 });
      }
      
      // Create auth directory  
      if (!fs.existsSync(this.authDir)) {
        fs.mkdirSync(this.authDir, { recursive: true, mode: 0o755 });
      }
      
      console.log(`✅ Directories created: ${this.baseTempDir}`);
    } catch (error) {
      console.error('❌ Error creating directories:', error);
      // Fallback to current directory if /tmp fails
      this.cacheDir = path.join(__dirname, '../group_cache');
      this.authDir = path.join(__dirname, '../auth');
    }
  }

  // 🆕 Start keep-alive to prevent timeouts
  startKeepAlive() {
    // Clear any existing interval
    this.stopKeepAlive();
    
    this.keepAliveInterval = setInterval(async () => {
      if (this.client && this.client.info && this.isFullyReady) {
        try {
          // Minimal activity to keep session alive - just check if browser is connected
          const browser = this.client.pupBrowser;
          if (browser && browser.isConnected()) {
            console.log('🫀 Keep-alive executed - session active');
          } else {
            console.log('❌ Keep-alive: Browser not connected');
            this.handleSessionRecovery();
          }
        } catch (error) {
          console.log('❌ Keep-alive failed:', error.message);
          this.handleSessionRecovery();
        }
      }
    }, 3 * 60 * 1000); // Every 3 minutes (more frequent)
  }

  // 🆕 Stop keep-alive
  stopKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
      console.log('🛑 Keep-alive stopped');
    }
  }

  // 🆕 Initialize client with a timeout wrapper to avoid hanging on QR init
  async initializeClientWithTimeout(timeoutMs = 60000) {
    if (!this.client || typeof this.client.initialize !== 'function') {
      throw new Error('Client instance not available for initialization');
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Client initialization timeout after ${timeoutMs} ms`));
      }, timeoutMs);

      this.client.initialize().then(() => {
        clearTimeout(timer);
        resolve();
      }).catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  // 🆕 Connection health check
  async checkConnectionHealth() {
    if (!this.client) {
      console.log('❌ Health check: No client');
      return false;
    }
    
    try {
      const browser = this.client.pupBrowser;
      if (!browser || !browser.isConnected()) {
        console.log('❌ Health check: Browser disconnected');
        return false;
      }
      
      // Try a simple operation to verify functionality
      await this.client.getWWebVersion();
      return true;
    } catch (error) {
      console.log('❌ Health check failed:', error.message);
      return false;
    }
  }

  // 🆕 Enhanced Session recovery method
  async handleSessionRecovery() {
    if (this.recoveryInProgress) {
      console.log('🔄 Session recovery already in progress...');
      return;
    }
  
    this.recoveryInProgress = true;
    console.log('🔄 Starting session recovery...');
    
    // Stop current bot and clean up
    this.stopBot();
    
    // Wait a bit for cleanup
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    try {
      console.log('🔄 Attempting to reinitialize bot...');
      await this.initializeBot(true); // Force restart
      console.log('✅ Session recovery completed');
    } catch (error) {
      console.error('❌ Session recovery failed:', error);
    } finally {
      this.recoveryInProgress = false;
    }
  }

  // 🆕 Improved session check with better debugging
  hasSession() {
    const sessionPath = path.join(this.authDir, 'session-admin');
    try {
      if (fs.existsSync(sessionPath)) {
        const files = fs.readdirSync(sessionPath);
        console.log(`🔍 Session files found:`, files);
        
        // More comprehensive session file check
        const hasSessionFiles = files.some(file => 
          file.includes('session') || 
          file.endsWith('.json') || 
          file === 'wwebjs.browserid' ||
          file === 'wwebjs.session.json' ||
          file.startsWith('LocalAuth')
        );
        
        console.log(`Session check: ${hasSessionFiles} (found ${files.length} files)`);
        return hasSessionFiles;
      }
      console.log('❌ Session path does not exist:', sessionPath);
      return false;
    } catch (error) {
      console.error('❌ Error checking session:', error);
      return false;
    }
  }

  // 🆕 Save session info for debugging
  saveSessionInfo() {
    try {
      const sessionPath = path.join(this.authDir, 'session-admin');
      if (fs.existsSync(sessionPath)) {
        const files = fs.readdirSync(sessionPath);
        const sessionInfo = {
          timestamp: new Date().toISOString(),
          files: files,
          fileCount: files.length,
          clientReady: !!(this.client && this.client.info),
          fullyReady: this.isFullyReady
        };
        
        const infoPath = path.join(this.authDir, 'session-info.json');
        fs.writeFileSync(infoPath, JSON.stringify(sessionInfo, null, 2));
        console.log('💾 Session info saved');
      }
    } catch (error) {
      console.error('❌ Error saving session info:', error);
    }
  }

  // 🆕 Add request to global queue and process if possible
  async addToQueue(message, chat, prompt, isSearchCommand) {
    // Create request object
    const request = {
      message,
      chat,
      prompt,
      isSearchCommand,
      timestamp: Date.now(),
      groupId: chat.id._serialized,
      groupName: chat.name
    };

    // Add request to global queue
    this.processingQueue.push(request);
    const queuePosition = this.processingQueue.length;
    console.log(`📝 [QUEUE] Added request to global queue. Queue length: ${queuePosition}, Group: ${chat.name}`);

    // If not currently processing, start processing
    if (!this.isProcessing) {
      this.processQueue();
    } else {
      // If already processing, notify user that their request is queued
      const waitMessage = `⏳ *Your request has been added to the queue.*\n\n` +
                         `📊 *Position in queue:* ${queuePosition}\n` +
                         `⏰ *Estimated wait time:* ${queuePosition * 2} minutes\n\n` +
                         `_Only one message can be processed at a time across all groups. Please wait for your turn._\n\n` +
                         `💎 *Upgrade to Pro* for priority processing and multiple concurrent requests!`;
      
      try {
        await message.reply(waitMessage);
        console.log(`📝 [QUEUE] Notified user of queue position ${queuePosition} for group ${chat.name}`);
      } catch (error) {
        console.error(`❌ [QUEUE] Failed to send queue notification:`, error);
      }
    }
  }

  // 🆕 Process the global queue
  async processQueue() {
    // If no queue or empty queue, return
    if (this.processingQueue.length === 0) {
      this.isProcessing = false;
      this.currentProcessingRequest = null;
      return;
    }

    // Mark as processing
    this.isProcessing = true;

    // Get the next request (FIFO - First In First Out)
    const request = this.processingQueue[0];
    this.currentProcessingRequest = request;
    
    console.log(`🔄 [QUEUE] Processing request from global queue. Group: ${request.groupName}, Remaining in queue: ${this.processingQueue.length - 1}`);

    try {
      // Notify user that processing is starting (if they're not the first in queue)
      if (this.processingQueue.length > 1) {
        try {
          const startMessage = `🚀 *Starting to process your request...*\n\n` +
                              `📝 _Please wait while I generate your response..._`;
          await request.message.reply(startMessage);
        } catch (notifyError) {
          console.error('Failed to send start notification:', notifyError);
        }
      }

      // Process the request
      await this.executeCommand(request.message, request.chat, request.prompt, request.isSearchCommand);
      
      // Remove the processed request from queue
      this.processingQueue.shift();
      this.currentProcessingRequest = null;
      console.log(`✅ [QUEUE] Request completed. Global queue length: ${this.processingQueue.length}`);
      
    } catch (error) {
      console.error(`❌ [QUEUE] Error processing request for group ${request.groupName}:`, error);
      // Remove the failed request from queue
      this.processingQueue.shift();
      this.currentProcessingRequest = null;
      
      // Notify user of error
      try {
        await request.message.reply('❌ Sorry, there was an error processing your request. Please try again.');
      } catch (replyError) {
        console.error('Failed to send error notification:', replyError);
      }
    } finally {
      // Process next request in queue after a short delay
      if (this.processingQueue.length > 0) {
        setTimeout(() => {
          this.processQueue();
        }, 2000); // 2 second delay between requests
      } else {
        this.isProcessing = false;
        this.currentProcessingRequest = null;
      }
    }
  }

  // 🆕 Extract the actual command execution logic
  async executeCommand(message, chat, prompt, isSearchCommand) {
    // 🆕 Check if client is ready before processing
    if (!this.isFullyReady) {
      console.log('❌ [EXECUTE] Client not fully ready, skipping command');
      await message.reply('❌ Bot is still initializing. Please try again in a moment.');
      return;
    }

    console.log(`🔔 [EXECUTE] Processing command for group ${chat.id._serialized}: "${prompt}"`);
    
    // Fetch last 101 messages
    const waMessages = await chat.fetchMessages({ limit: 101 });

    const metadata = await chat.groupMetadata;
    if (!metadata || !metadata.participants) {
      console.log(`❌ [EXECUTE] No group metadata available.`);
      return;
    }

    // Build participant map
    const participantMap = new Map();
    const fetchPromises = metadata.participants.map(async (participant) => {
      try {
        const contact = await this.client.getContactById(participant.id);
        const name = contact.pushname || contact.verifiedName || contact.number || participant.id._serialized.split('@')[0];
        participantMap.set(participant.id._serialized, name);
      } catch (err) {
        console.warn(`⚠️ [EXECUTE] Failed to fetch contact for ${participant.id._serialized}:`, err.message);
        participantMap.set(participant.id._serialized, participant.id._serialized.split('@')[0]);
      }
    });
    await Promise.all(fetchPromises);

    // Format messages
    const formattedMessages = [];
    for (const msg of waMessages) {
      if (!msg.body || msg.fromMe) continue;
      const senderId = msg.author || msg.from;
      const userName = participantMap.get(senderId) || senderId.split('@')[0];
      formattedMessages.push({
        timestamp: new Date(msg.timestamp * 1000).toISOString().slice(0, 19).replace('T', ' '),
        user: userName,
        message: msg.body,
        group_name: chat.name,
      });
    }

    // Sort ascending by timestamp
    formattedMessages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    // Use up to the last 100 as history
    const currentMessages = formattedMessages.slice(-100);

    // Get only new messages using cache
    const newMessages = this.getNewMessages(chat.id._serialized, currentMessages);

    // Always update cache with current 100 messages
    this.saveGroupCache(chat.id._serialized, currentMessages);

    console.log(`🔔 [EXECUTE] Using ${newMessages.length} new messages (from ${currentMessages.length} total) for context...`);

    console.log(`🔔 [EXECUTE] Calling external API...`);
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

    console.log(`🔔 [EXECUTE] Attempting to reply to message...`);
    await message.reply(response);
    console.log(`✅ [EXECUTE] Reply sent successfully.`);
  }

  // Generate a safe filename for group cache
  getGroupCacheFilename(groupId) {
    const safeId = groupId.replace(/[^a-zA-Z0-9]/g, '_');
    return path.join(this.cacheDir, `group_${safeId}.json`);
  }

  // Load cached messages for a group
  loadGroupCache(groupId) {
    try {
      const cacheFile = this.getGroupCacheFilename(groupId);
      if (fs.existsSync(cacheFile)) {
        const data = fs.readFileSync(cacheFile, 'utf8');
        const cache = JSON.parse(data);
        console.log(`📁 [CACHE] Loaded ${cache.messages.length} cached messages for group ${groupId}`);
        return cache.messages || [];
      }
    } catch (error) {
      console.error(`❌ [CACHE] Error loading cache for group ${groupId}:`, error);
    }
    return [];
  }

  // Save messages to group cache
  saveGroupCache(groupId, messages) {
    try {
      const cacheFile = this.getGroupCacheFilename(groupId);
      const cacheData = {
        groupId: groupId,
        lastUpdated: new Date().toISOString(),
        messageCount: messages.length,
        messages: messages
      };
      fs.writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2));
      console.log(`💾 [CACHE] Saved ${messages.length} messages for group ${groupId}`);
    } catch (error) {
      console.error(`❌ [CACHE] Error saving cache for group ${groupId}:`, error);
    }
  }

  // Compare current messages with cached messages and return only new ones
  getNewMessages(groupId, currentMessages) {
    const cachedMessages = this.loadGroupCache(groupId);
    
    if (cachedMessages.length === 0) {
      console.log(`🆕 [CACHE] No cached messages found for group ${groupId}, using all ${currentMessages.length} messages`);
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

    console.log(`🔍 [CACHE] Group ${groupId}: ${cachedMessages.length} cached, ${currentMessages.length} current, ${newMessages.length} new messages`);

    return newMessages;
  }

  // Save the activeGroups array to a JSON file
  saveActiveGroupsToDisk() {
    const dataPath = path.join(this.authDir, 'activeGroups.json');
    fs.writeFileSync(dataPath, JSON.stringify(this.activeGroups));
    console.log('Active groups saved to disk.');
  }

  // Load the activeGroups array from a JSON file
  loadActiveGroupsFromDisk() {
    const dataPath = path.join(this.authDir, 'activeGroups.json');
    try {
      if (fs.existsSync(dataPath)) {
        const data = fs.readFileSync(dataPath, 'utf8');
        this.activeGroups = JSON.parse(data);
        console.log('Active groups loaded from disk:', this.activeGroups);
      }
    } catch (error) {
      console.error('Error loading active groups:', error);
    }
  }

  // Add socket connection for frontend
  addSocketConnection(socket) {
    this.socketConnections.push(socket);
    console.log('Socket connection added. Total connections:', this.socketConnections.length);
    
    // Send current status to the new connection
    this.emitToAllSockets('bot-status', { 
      status: this.getBotStatus(),
      qrCode: this.currentQrCode
    });
    
    // Send current active groups
    this.emitToAllSockets('active-groups-updated', { groups: this.activeGroups });
  }

  // Remove socket connection
  removeSocketConnection(socket) {
    this.socketConnections = this.socketConnections.filter(s => s !== socket);
    console.log('Socket connection removed. Total connections:', this.socketConnections.length);
    
    // 🆕 Reset initialization if no clients are connected
    if (this.socketConnections.length === 0 && this.isInitializing && !this.client) {
      console.log('🔄 No clients connected, resetting initialization state');
      this.isInitializing = false;
    }
  }

  // Emit to all connected sockets
  emitToAllSockets(event, data) {
    this.socketConnections.forEach(socket => {
      try {
        socket.emit(event, data);
      } catch (error) {
        console.error('Error emitting to socket:', error);
      }
    });
  }

  // 🆕 Method to regenerate QR code for existing clients
  async regenerateQRCode() {
    if (!this.client) {
      console.log('❌ No client instance to regenerate QR code');
      return false;
    }
    
    try {
      // Force new QR code generation
      await this.client.logout();
      await this.client.initialize();
      console.log('🔄 QR code regeneration triggered');
      return true;
    } catch (error) {
      console.error('❌ Error regenerating QR code:', error);
      return false;
    }
  }

  async handleInitializationTimeout() {
    console.log('⏰ [TIMEOUT] Handling initialization timeout...');
    this.isInitializing = false;
    this.isFullyReady = false;
    
    // Clean up resources
    await this.stopBot();
    
    // Clear the auth session to force fresh QR generation
    await this.clearProblematicSession();
    
    console.log('🔄 Retrying initialization after timeout...');
    // Retry after a short delay
    setTimeout(() => {
        this.initializeBot(true);
    }, 5000);
  }

  async initializeBot(forceRestart = false) {
    if (this.isInitializing && !forceRestart) {
      console.log('Bot is already initializing...');
      return;
    }

    // 🆕 Clear any existing timeout
    if (this.initializationTimeout) {
      clearTimeout(this.initializationTimeout);
      this.initializationTimeout = null;
    }

    this.isInitializing = true;
    this.isFullyReady = false;
    this.initializationStartTime = Date.now();
    
    console.log(`⏱️ [INIT] Starting bot initialization at ${new Date().toISOString()}`);
    
    // 🆕 Set initialization timeout
    this.initializationTimeout = setTimeout(() => {
      if (this.isInitializing && !this.isFullyReady) {
        console.log('⏰ [TIMEOUT] Initialization timeout after 2 minutes, forcing recovery...');
        this.handleInitializationTimeout();
      }
    }, this.maxInitializationTime);

    try {
      console.log('🚀 Launching Playwright Chromium browser...');

      // 🆕 Use temp directory for browser data
      const userDataDir = path.join(this.baseTempDir, 'chrome-data');
      console.log(`📁 [BROWSER] User data directory: ${userDataDir}`);
      
      // 🆕 Enhanced browser launch with better error handling
      const browserStartTime = Date.now();
      this.browserContext = await chromium.launchPersistentContext(userDataDir, {
        headless: true,
        // 🆕 Reduced args for better stability
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--disable-web-security',
          '--disable-features=site-per-process',
          '--disable-background-timer-throttling'
        ],
        // 🆕 Add viewport for better compatibility
        viewport: { width: 1280, height: 720 },
        // 🆕 Reduce timeout for faster failure detection
        timeout: 30000
      });
      
      console.log(`✅ [BROWSER] Browser launched in ${Date.now() - browserStartTime}ms`);

      const pages = this.browserContext.pages();
      const page = pages.length > 0 ? pages[0] : await this.browserContext.newPage();
      console.log(`📄 [BROWSER] Using page: ${pages.length} existing pages`);

      // 🆕 Optimized WhatsApp client configuration
      const playwrightConfig = {
        authStrategy: new LocalAuth({ 
          clientId: 'admin',
          dataPath: this.authDir  // 🆕 Use temp auth directory
        }),
        puppeteer: {
          browser: this.browserContext.browser(),
          launch: async () => this.browserContext.browser(),
          browserContext: this.browserContext,
          page: page
        },
        // 🆕 Optimized WhatsApp Web.js options
        webVersionCache: {
          type: 'remote',
          remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
          // 🆕 Add timeout for version fetch
          timeout: 10000
        },
        // 🆕 Reduced timeouts for faster failure detection
        takeoverTimeoutMs: 30000,
        qrMaxRetries: 10,
        authTimeoutMs: 30000,
        // 🆕 Disable auto-reconnect during initial setup
        restartOnCrash: false,
        // 🆕 Add QR refresh interval
        qrRefreshInterval: 10000,
        // 🆕 Disable some features for faster initialization
        disableWelcome: true,
        // 🆕 Use newer authentication strategy
        authTimeout: 0 // No timeout for QR code
      };

      // 🆕 Save session info before initialization
      this.saveSessionInfo();

      if (this.hasSession()) {
        console.log('✅ Found persistent session, attempting to restore with Playwright');
        this.client = new Client(playwrightConfig);
        this.setupClientEvents();
        
        const clientInitStart = Date.now();
        console.log(`⏱️ [CLIENT] Starting client initialization...`);
        await this.client.initialize();
        console.log(`✅ [CLIENT] Client initialized in ${Date.now() - clientInitStart}ms`);
      } else {
        console.log('❌ No existing session found, requiring QR scan with Playwright');
        this.client = new Client(playwrightConfig);
        this.setupClientEvents();
        
        const clientInitStart = Date.now();
        console.log(`⏱️ [CLIENT] Starting client initialization (QR required)...`);
        
        // 🆕 Add initialization with timeout wrapper
        await this.initializeClientWithTimeout();
        console.log(`✅ [CLIENT] Client initialized in ${Date.now() - clientInitStart}ms`);
      }
      
      // 🆕 Clear the timeout on successful initialization
      if (this.initializationTimeout) {
        clearTimeout(this.initializationTimeout);
        this.initializationTimeout = null;
      }
      
      console.log(`✅ [INIT] Bot initialization completed in ${Date.now() - this.initializationStartTime}ms`);
      
    } catch (error) {
      console.error(`❌ [INIT] Error initializing bot with Playwright after ${Date.now() - this.initializationStartTime}ms:`, error);
      
      // 🆕 Clear timeout on error
      if (this.initializationTimeout) {
        clearTimeout(this.initializationTimeout);
        this.initializationTimeout = null;
      }
      
      this.emitToAllSockets('bot-error', { error: error.message });
      this.isInitializing = false;
      this.isFullyReady = false;
      
      // 🆕 Clean up browser on error
      if (this.browserContext) {
        await this.browserContext.close();
        this.browserContext = null;
      }
      
      // 🆕 Auto-retry after shorter delay
      setTimeout(() => {
        console.log('🔄 Auto-retrying initialization after error...');
        this.initializeBot(true);
      }, 10000);
    }
  }

// 🆕 Clear problematic session files
  async clearProblematicSession() {
    try {
      const sessionPath = path.join(this.authDir, 'session-admin');
      if (fs.existsSync(sessionPath)) {
        console.log('🗑️ Clearing potentially problematic session...');
        const files = fs.readdirSync(sessionPath);
        
        // Remove specific session files but keep some configuration
        for (const file of files) {
          if (file.includes('session') || file === 'wwebjs.session.json' || file === 'wwebjs.browserid') {
            const filePath = path.join(sessionPath, file);
            fs.unlinkSync(filePath);
            console.log(`🗑️ Removed session file: ${file}`);
          }
        }
      }
    } catch (error) {
      console.error('❌ Error clearing session:', error);
    }
  }

  // 🆕 Enhanced client event setup with better QR handling
  setupClientEvents() {
    if (!this.client) return;

    let qrResolve, qrReject;
    let qrPromise = new Promise((resolve, reject) => {
      qrResolve = resolve;
      qrReject = reject;
    });

    let qrTimeout = null;
    let authenticated = false;

    // 🆕 QR code event with enhanced logging
    this.client.on('qr', async (qr) => {
      console.log(`📱 [QR] QR code received at ${new Date().toISOString()}`);
      
      // 🆕 Clear any existing QR timeout
      if (qrTimeout) {
        clearTimeout(qrTimeout);
      }

      try {
        const qrStartTime = Date.now();
        console.log(`⏱️ [QR] Generating QR code image...`);
        
        // 🆕 Optimized QR code generation
        const qrImage = await QRCode.toDataURL(qr, {
          width: 300,
          margin: 1,
          color: {
            dark: '#000000',
            light: '#FFFFFF'
          }
        });
        
        console.log(`✅ [QR] QR code generated in ${Date.now() - qrStartTime}ms`);
        
        this.currentQrCode = qrImage;
        this.emitToAllSockets('qr-code', { qr: qrImage });
        this.emitToAllSockets('bot-status', { status: 'scan_qr' });
        
        console.log(`✅ [QR] QR code sent to ${this.socketConnections.length} clients`);
        
        // 🆕 Set timeout for QR code expiration (5 minutes)
        qrTimeout = setTimeout(() => {
          if (!authenticated) {
            console.log('⏰ [QR] QR code expired, regenerating...');
            this.emitToAllSockets('bot-error', { error: 'QR code expired. Please try scanning again.' });
            // The client should automatically refresh QR if needed
          }
        }, 5 * 60 * 1000);
        
        qrResolve();
        
      } catch (error) {
        console.error(`❌ [QR] Error generating QR code:`, error);
        qrReject(error);
      }
    });

    this.client.on('ready', () => {
      console.log(`✅ [READY] Bot connected successfully via Playwright at ${new Date().toISOString()}`);
      console.log(`⏱️ [READY] Total initialization time: ${Date.now() - this.initializationStartTime}ms`);
      
      authenticated = true;
      if (qrTimeout) {
        clearTimeout(qrTimeout);
      }
      
      this.emitToAllSockets('bot-status', { status: 'connected' });
      this.isInitializing = false;
      this.isFullyReady = true;
      
      // 🆕 Save session info after successful connection
      this.saveSessionInfo();
      
      // 🆕 Start keep-alive when bot is ready with delay
      setTimeout(() => {
        this.startKeepAlive();
        console.log('✅ Keep-alive service started');
      }, 10000);
    });

    this.client.on('authenticated', (session) => {
      console.log(`✅ [AUTH] Bot authenticated via Playwright at ${new Date().toISOString()}`);
      authenticated = true;
      if (qrTimeout) {
        clearTimeout(qrTimeout);
      }
      this.emitToAllSockets('bot-status', { status: 'authenticated' });
      this.saveSessionInfo();
    });

    this.client.on('auth_failure', (error) => {
      console.error(`❌ [AUTH] Bot auth failed via Playwright:`, error);
      authenticated = false;
      this.emitToAllSockets('bot-error', { error: 'Authentication failed' });
      this.isInitializing = false;
      this.isFullyReady = false;
      this.stopKeepAlive();
    });

    this.client.on('disconnected', (reason) => {
      console.log(`❌ [DISCONNECT] Bot disconnected: ${reason}`);
      authenticated = false;
      this.handleDisconnection();
    });

    this.client.on('message', async (message) => {
      await this.handleMessage(message);
    });

    // 🆕 Add loading state event with timing
    this.client.on('loading_screen', (percent, message) => {
      console.log(`📱 [LOADING] ${percent}% - ${message}`);
      this.emitToAllSockets('bot-status', { status: 'loading', percent, message });
    });

    // 🆕 Add more debug events
    this.client.on('change_state', (state) => {
      console.log(`🔁 [STATE] State changed to: ${state}`);
    });

    return qrPromise;
  }

  // 🆕 Enhanced disconnection handling
  async handleDisconnection() {
    this.emitToAllSockets('bot-status', { status: 'disconnected' });
    this.client = null;
    this.isProcessing = false;
    this.isFullyReady = false;
    
    this.stopKeepAlive();
    
    // 🆕 Clear global queue on disconnect
    this.processingQueue = [];
    this.currentProcessingRequest = null;
    
    // 🆕 Save session info after disconnect
    this.saveSessionInfo();
    
    // 🆕 Close browser context
    if (this.browserContext) {
      await this.browserContext.close();
      this.browserContext = null;
    }
    
    // 🆕 Retry with exponential backoff
    const retryDelay = 15000;
    console.log(`🔄 Attempting to reconnect in ${retryDelay/1000} seconds...`);
    
    setTimeout(() => {
      console.log('🔄 Starting reconnection...');
      this.initializeBot();
    }, retryDelay);
  }

  // 🆕 Safe stop method to prevent crashes and ensure async cleanup
  async safeStopBot() {
    console.log('🛑 Safely stopping bot...');

    // Clear initialization timeout
    if (this.initializationTimeout) {
      clearTimeout(this.initializationTimeout);
      this.initializationTimeout = null;
    }

    this.stopKeepAlive();

    // Safely destroy the client
    if (this.client) {
      try {
        // Only destroy if client is available
        if (this.client.destroy && typeof this.client.destroy === 'function') {
          await this.client.destroy();
        }
      } catch (err) {
        console.warn('⚠️ Error while destroying client:', err && err.message ? err.message : err);
      }
      this.client = null;
    }

    // Safely close browser context
    if (this.browserContext) {
      try {
        await this.browserContext.close();
      } catch (err) {
        console.warn('⚠️ Error while closing browser context:', err && err.message ? err.message : err);
      }
      this.browserContext = null;
    }

    this.isInitializing = false;
    this.isFullyReady = false;

    // Clear global queue on stop
    this.processingQueue = [];
    this.isProcessing = false;
    this.currentProcessingRequest = null;

    console.log('✅ Bot safely stopped');
  }

  // Public stopBot wrapper
  async stopBot() {
    await this.safeStopBot();
  }

  async getGroups() {
    // 🆕 Check if client is fully ready before attempting group fetch
    if (!this.isFullyReady) {
      console.log('❌ Client not fully ready for group fetch, delaying...');
      return new Promise((resolve) => {
        setTimeout(async () => {
          const groups = await this.getGroups();
          resolve(groups);
        }, 5000);
      });
    }

    try {
      // 🆕 Health check before proceeding
      const isHealthy = await this.checkConnectionHealth();
      if (!isHealthy) {
        console.log('❌ Connection unhealthy in getGroups, attempting recovery...');
        this.handleSessionRecovery();
        return [];
      }

      if (!this.client || !this.client.info) {
        console.log('❌ Client not ready for getGroups');
        return [];
      }

      // 🆕 Additional browser context check
      try {
        const browser = this.client.pupBrowser;
        if (!browser || !browser.isConnected()) {
          console.log('❌ Browser disconnected, cannot fetch groups');
          this.handleSessionRecovery();
          return [];
        }
      } catch (browserError) {
        console.log('❌ Browser context invalid:', browserError.message);
        this.handleSessionRecovery();
        return [];
      }

      console.log('🔄 Fetching groups from WhatsApp...');
      const chats = await this.client.getChats();
      const groups = chats.filter(chat => chat.isGroup);
      
      console.log(`✅ Successfully fetched ${groups.length} groups`);
      return groups.map(group => ({
        id: group.id._serialized,
        name: group.name,
        participants: group.participants.length
      }));
    } catch (error) {
      console.error('❌ Critical error fetching groups:', error);
      
      // 🆕 Attempt to restart if session is dead
      if (error.message.includes('Session closed') || 
          error.message.includes('Target closed') ||
          error.message.includes('Protocol error')) {
        console.log('🔄 Session dead, attempting recovery...');
        this.handleSessionRecovery();
      }
      
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
    if (this.client && this.client.info && this.isFullyReady) return 'connected';
    if (this.hasSession()) return 'session_exists';
    return 'disconnected';
  }

  async handleMessage(message) {
    // 🆕 Check if client is ready before processing messages
    if (!this.isFullyReady) {
      console.log('❌ Client not fully ready, ignoring message');
      return;
    }

    console.log(`🔔 [DEBUG] Received message: "${message.body}"`);
    console.log(`🔔 [DEBUG] Message is from me? ${message.fromMe}. Chat is group? ${(await message.getChat()).isGroup}`);

    if (this.activeGroups.length === 0) {
      console.log(`❌ [DEBUG] No active groups found. activeGroups:`, this.activeGroups);
      return;
    }
    
    const chat = await message.getChat();
    if (!chat.isGroup) {
      console.log(`❌ [DEBUG] Message not from a group chat. Exiting.`);
      return;
    }

    console.log(`🔔 [DEBUG] Active groups:`, this.activeGroups);
    console.log(`🔔 [DEBUG] Current chat ID: ${chat.id._serialized}`);

    if (!this.activeGroups.includes(chat.id._serialized)) {
      console.log(`❌ [DEBUG] Chat ID ${chat.id._serialized} not in active groups. Exiting.`);
      return;
    }

    const messageTimestamp = message.timestamp;
    const twoMinutesAgo = Date.now() / 1000 - 120;

    if (messageTimestamp < twoMinutesAgo) {
      console.log(`❌ [DEBUG] Message is too old. Ignoring.`);
      return;
    }

    const messageText = message.body;
    console.log(`🔔 [DEBUG] Processing message text: "${messageText}"`);
    
    if (this.isBotCommand(messageText)) {
      console.log(`✅ [DEBUG] Bot command detected! Adding to global queue.`);
      
      const isSearchCommand = messageText.toLowerCase().includes('!ai_search');
      const prompt = this.extractPrompt(message.body, isSearchCommand);
      
      if (!prompt) {
        console.log(`❌ [DEBUG] No prompt extracted from message.`);
        return;
      }

      // 🆕 Add to global queue instead of processing immediately
      await this.addToQueue(message, chat, prompt, isSearchCommand);
    } else {
      console.log(`❌ [DEBUG] Not a bot command.`);
    }
  }

  isBotCommand(messageText) {
    const commands = ['!bot', '!ai', '@bot', 'bot,', '!ai_search'];
    return commands.some(cmd => messageText.toLowerCase().includes(cmd));
  }

  async callExternalAPI(payload) {
    const apiUrl = process.env.API_ENDPOINT;
    const generateEndpoint = `${apiUrl}/generate_real_time`;
    console.log(`🔔 [DEBUG] Making Axios call to: ${generateEndpoint}`);
    console.log(`📊 [CACHE] Sending ${payload.messages.length} new messages (out of ${payload.totalMessageCount} total)`);

    try {
      console.log('🔍 [DEBUG] Payload preview:', JSON.stringify(payload).slice(0, 500));

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
          timeout: 15 * 60 * 1000,
          headers: { 'Content-Type': 'application/json' },
          withCredentials: false,
        }
      );

      console.log(`✅ [DEBUG] Axios response status: ${response.status}`);
      console.log(`✅ [DEBUG] Axios response data:`, response.data);

      const data = response.data;
      return (
        data.response ||
        data.answer ||
        data.text ||
        'I received your message but cannot generate a response right now.'
      );

    } catch (error) {
      if (error.code === 'ECONNABORTED') {
        console.error('⏰ Axios request timed out after 15 minutes');
        return 'Sorry, the request took too long. Please try again later.';
      } else if (error.response) {
        console.error('🚨 Server responded with error:', error.response.status, error.response.data);
        return `The AI server returned an error: ${error.response.status}`;
      } else if (error.request) {
        console.error('⚠️ No response received from server. Request details:', error.request);
        return 'No response received from the AI server.';
      } else {
        console.error('❌ Axios request setup failed:', error.message);
        return 'Failed to connect to the AI service.';
      }
    }
  }

  async callExternalAPISearch(payload) {
    const apiUrl = process.env.API_ENDPOINT;
    const generateEndpoint = `${apiUrl}/generate_realtime_search`;
    console.log(`🔔 [DEBUG] Making Axios call to SEARCH endpoint: ${generateEndpoint}`);
    console.log(`📊 [CACHE] Sending ${payload.messages.length} new messages (out of ${payload.totalMessageCount} total)`);

    try {
      console.log('🔍 [DEBUG] Search payload preview:', JSON.stringify(payload).slice(0, 500));

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
          timeout: 15 * 60 * 1000,
          headers: { 'Content-Type': 'application/json' },
          withCredentials: false,
        }
      );

      console.log(`✅ [DEBUG] Search Axios response status: ${response.status}`);
      console.log(`✅ [DEBUG] Search Axios response data:`, response.data);

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
        if (data.search_info.domains && data.search_info.domains.length > 0) {
          responseText += ` from ${data.search_info.domains.join(', ')}`;
        }
      }
      
      return responseText;

    } catch (error) {
      if (error.code === 'ECONNABORTED') {
        console.error('⏰ Search Axios request timed out after 15 minutes');
        return 'Sorry, the web search request took too long. Please try again later or use !ai for a faster response.';
      } else if (error.response) {
        console.error('🚨 Search server responded with error:', error.response.status, error.response.data);
        return `The AI search server returned an error: ${error.response.status}. Try !ai for a regular response.`;
      } else if (error.request) {
        console.error('⚠️ No response received from search server. Request details:', error.request);
        return 'No response received from the AI search server. Try !ai for a regular response.';
      } else {
        console.error('❌ Search Axios request setup failed:', error.message);
        return 'Failed to connect to the AI search service. Try !ai for a regular response.';
      }
    }
  }

  extractPrompt(messageText, isSearchCommand = false) {
    if (isSearchCommand) {
      return messageText.replace(/(!ai_search)\s*/i, '').trim();
    } else {
      return messageText.replace(/(!bot|!ai|@bot|bot,)\s*/i, '').trim();
    }
  }

  async manualRestart() {
    console.log('🔧 Manual restart requested...');
    this.stopBot();
    await new Promise(resolve => setTimeout(resolve, 3000));
    await this.initializeBot(true);
  }
}

export default BotManager;