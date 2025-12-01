// backend/src/botManager.js - VERSION ASLI TANPA GITHUB ACTIONS MODE
import pkg from 'whatsapp-web.js';
const { Client, RemoteAuth } = pkg;
import QRCode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import axios from 'axios';
import { supabase } from './supabaseClient.js';
import { SupabaseRemoteAuthStore } from './SupabaseRemoteAuthStore.js';

// Error handling
process.on('unhandledRejection', (reason, promise) => {
  console.log('🔶 Unhandled Rejection at:', promise, 'reason:', reason);
  
  if (reason.code === 'ENOENT' && reason.path && reason.path.includes('wwebjs_temp_session_admin')) {
    console.log('🔶 Ignoring RemoteAuth temporary directory cleanup error - this is normal');
    return;
  }
  
  console.error('🔶 Unhandled Rejection (non-critical):', reason);
});

process.on('uncaughtException', (error) => {
  console.error('🔴 Uncaught Exception:', error);
  
  if (error.code === 'ENOENT' && error.path && error.path.includes('wwebjs_temp_session_admin')) {
    console.log('🔶 Ignoring RemoteAuth file system error - this is normal');
    return;
  }
  
  console.error('🔴 Critical error,可能需要重启:', error);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class BotManager {
  constructor() {
    this.client = null;
    this.activeGroups = [];
    this.socketConnections = [];
    this.isInitializing = false;
    this.currentQrCode = null;
    
    // Session recovery settings
    this.sessionRecovery = {
      maxRetries: 3,
      currentRetries: 0,
      retryDelay: 5000,
      maxSessionAge: 24 * 60 * 60 * 1000,
      lastSessionTime: null
    };
    
    this.supabaseStore = null;
    
    // Paths biasa, gak ada mode GitHub Actions
    this.authPath = process.env.NODE_ENV === 'production' 
      ? path.join('/tmp/whatsapp_auth')
      : path.join(__dirname, '../auth');
    
    this.cacheDir = process.env.NODE_ENV === 'production'
      ? '/tmp/group_cache'
      : path.join(__dirname, '../group_cache');
    
    this.ensureDirectoryExists(this.authPath);
    this.ensureDirectoryExists(this.cacheDir);

    // Group caching
    this.groupsCache = {
      data: [],
      lastUpdated: 0,
      cacheDuration: 5 * 60 * 1000,
      isUpdating: false
    };
    
    // Global queue
    this.processingQueue = [];
    this.isProcessing = false;
    this.currentProcessingRequest = null;
    this.maxQueueSize = 10;
    
    // Rate limiting
    this.lastCommandTime = 0;
    this.minCommandInterval = 3000;
    
    // In-memory cache
    this.groupCaches = new Map();
    this.maxCachedGroups = 5;
    this.maxCachedMessages = 30;

    this.sessionRetryAttempts = 0;
    this.maxSessionRetries = 3;
    this.isWaitingForSession = false;
    this.forceQR = false;

    // Supabase storage monitoring
    this.supabaseMonitor = {
      lastSizeCheck: 0,
      checkInterval: 10 * 60 * 1000,
      lastPurgeTime: 0,
      minPurgeInterval: 30 * 60 * 1000,
    };

    // Start monitoring
    setTimeout(() => {
      this.startSupabaseMonitoring();
    }, 10000);
    
    this.startMemoryMonitoring();
    this.loadActiveGroupsFromSupabase();
    this.initializeBot();
  }

  startSupabaseMonitoring() {
    setInterval(async () => {
      await this.checkSupabaseStorage();
    }, this.supabaseMonitor.checkInterval);
    
    setTimeout(() => {
      this.checkSupabaseStorage();
    }, 60000);
  }

  async checkSupabaseStorage() {
    try {
      const now = Date.now();
      if (now - this.supabaseMonitor.lastPurgeTime < this.supabaseMonitor.minPurgeInterval) {
        return;
      }

      if (this.supabaseStore) {
        const stats = await this.supabaseStore.getStorageStats();
        console.log(`📊 Supabase session storage: ${stats.sessionsCount} sessions, ${stats.totalSizeMB}MB`);
        
        // Clean up sessions older than 7 days
        if (stats.sessionsCount > 5) {
          const cleaned = await this.supabaseStore.cleanupOldSessions(7 * 24);
          if (cleaned > 0) {
            console.log(`🧹 Cleaned ${cleaned} old sessions from Supabase`);
            this.supabaseMonitor.lastPurgeTime = Date.now();
          }
        }
      }
    } catch (error) {
      console.error('Error checking Supabase storage:', error);
    }
  }

  ensureDirectoryExists(dirPath) {
    try {
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        console.log(`Created directory: ${dirPath}`);
      }
    } catch (error) {
      console.error(`Failed to create directory ${dirPath}:`, error);
    }
  }

  startMemoryMonitoring() {
    setInterval(() => {
      this.checkMemoryUsage();
    }, 30000);
  }

  checkMemoryUsage() {
    const used = process.memoryUsage();
    const usedMB = Math.round(used.heapUsed / 1024 / 1024);
    const totalMB = Math.round(used.heapTotal / 1024 / 1024);
    
    console.log(`Memory usage: ${usedMB}MB / ${totalMB}MB`);
    
    if (usedMB > 200) {
      console.log('High memory usage detected, performing cleanup...');
      this.performMemoryCleanup();
    }
  }

  performMemoryCleanup() {
    console.log('Performing memory cleanup...');
    
    if (this.processingQueue.length > this.maxQueueSize) {
      console.log(`Trimming queue from ${this.processingQueue.length} to ${this.maxQueueSize} items`);
      this.processingQueue = this.processingQueue.slice(0, this.maxQueueSize);
    }
    
    if (this.groupCaches.size > this.maxCachedGroups) {
      const entries = Array.from(this.groupCaches.entries());
      const recentEntries = entries.slice(-this.maxCachedGroups);
      this.groupCaches = new Map(recentEntries);
      console.log(`Cleared group caches, keeping ${recentEntries.length} groups`);
    }
    
    if (global.gc) {
      global.gc();
      console.log('Forced garbage collection');
    }
  }

  async shouldForceQR() {
    if (this.sessionRecovery.currentRetries >= this.sessionRecovery.maxRetries) {
      console.log(`🔄 Max session retries (${this.sessionRecovery.maxRetries}) exceeded, forcing QR`);
      return true;
    }
    
    if (this.sessionRecovery.lastSessionTime) {
      const sessionAge = Date.now() - this.sessionRecovery.lastSessionTime;
      if (sessionAge > this.sessionRecovery.maxSessionAge) {
        console.log(`🔄 Session is too old (${Math.round(sessionAge / (60 * 60 * 1000))} hours), forcing QR`);
        return true;
      }
    }
    
    return this.forceQR;
  }

  async recoverFromSessionError(error) {
    this.sessionRecovery.currentRetries++;
    console.log(`🔄 Session recovery attempt ${this.sessionRecovery.currentRetries}/${this.sessionRecovery.maxRetries}`);
    
    if (this.client) {
      try {
        await this.client.destroy();
      } catch (e) {
        console.log('Error destroying client during recovery:', e);
      }
      this.client = null;
    }
    
    await new Promise(resolve => setTimeout(resolve, this.sessionRecovery.retryDelay));
    
    if (this.sessionRecovery.currentRetries >= this.sessionRecovery.maxRetries) {
      console.log('🔄 Max retries reached, forcing QR generation');
      await this.clearSession();
      this.forceQR = true;
    }
    
    this.isInitializing = false;
    await this.initializeBot();
  }

  isSessionError(error) {
    const sessionErrors = [
      'ProtocolError',
      'Execution context was destroyed',
      'Session',
      'Authentication',
      'No Page',
      'Target closed'
    ];
    
    return sessionErrors.some(errorType => 
      error.name?.includes(errorType) || 
      error.message?.includes(errorType) ||
      error.originalMessage?.includes(errorType)
    );
  }

  async getGroups() {
    try {
      if (!this.client || !this.client.info) {
        console.log('Bot client not ready');
        return [];
      }

      console.time('QuickGroupFetch');
      const chats = await this.client.getChats();
      console.timeEnd('QuickGroupFetch');

      if (!Array.isArray(chats)) return [];

      const groups = [];
      let count = 0;
      const MAX_GROUPS = 50;

      for (const chat of chats) {
        if (count >= MAX_GROUPS) break;
        if (chat?.isGroup) {
          groups.push({
            id: chat.id?._serialized,
            name: chat.name || chat.subject || 'Unknown Group',
            participantCount: chat.participants?.length || 0,
          });
          count++;
        }
      }

      console.log(`Quickly loaded ${groups.length} groups`);
      return groups;

    } catch (error) {
      console.error('Error in quick groups fetch:', error);
      return [];
    }
  }

  async searchGroups(query) {
    try {
      if (!this.client || !this.client.info || !query || query.length < 2) return [];

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
            if (results.length >= 20) break;
          }
        }
      }

      console.log(`Found ${results.length} groups matching "${query}"`);
      return results;

    } catch (error) {
      console.error('Error searching groups:', error);
      return [];
    }
  }

  async getSavedGroups(groupIds) {
    try {
      if (!this.client || !this.client.info || !Array.isArray(groupIds) || groupIds.length === 0) return [];

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
        if (savedGroups.length % 10 === 0) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }

      console.log(`Loaded ${savedGroups.length} saved groups`);
      return savedGroups;

    } catch (error) {
      console.error('Error loading saved groups:', error);
      return [];
    }
  }

  async refreshGroups() {
    console.log('Manually refreshing groups cache...');
    return await this.getGroups(true);
  }

  async addToQueue(message, chat, prompt, isSearchCommand) {
    const now = Date.now();
    if (now - this.lastCommandTime < this.minCommandInterval) {
      try {
        await message.reply('Please wait a few seconds before sending another command.');
      } catch (error) {
        console.error('Failed to send rate limit message:', error);
      }
      return;
    }

    if (this.processingQueue.length >= this.maxQueueSize) {
      try {
        await message.reply('*Queue is full!*\n\nPlease try again later when the queue has space.');
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
    console.log(`[QUEUE] Added request. Position: ${queuePosition}, Group: ${chat.name}`);

    if (!this.isProcessing) {
      this.processQueue();
    } else {
      const waitMessage = `*Your request has been added to the queue.*\n\n` +
                         `*Position in queue:* ${queuePosition}\n` +
                         `*Estimated wait time:* ${queuePosition * 1} minute(s)\n\n` +
                         `_Only one message can be processed at a time across all groups._`;
      
      try {
        await message.reply(waitMessage);
      } catch (error) {
        console.error(`[QUEUE] Failed to send queue notification:`, error);
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
    
    console.log(`[QUEUE] Processing request. Group: ${request.groupName}, Remaining: ${this.processingQueue.length - 1}`);

    try {
      if (this.processingQueue.length > 1) {
        const startMessage = `*Starting to process your request...*\n\n` +
                            `_Please wait while I generate your response..._`;
        await request.message.reply(startMessage);
      }

      await this.executeCommand(request.message, request.chat, request.prompt, request.isSearchCommand);
      
      this.processingQueue.shift();
      this.currentProcessingRequest = null;
      console.log(`[QUEUE] Request completed. Queue length: ${this.processingQueue.length}`);
      
    } catch (error) {
      console.error(`[QUEUE] Error processing request for group ${request.groupName}:`, error);
      this.processingQueue.shift();
      this.currentProcessingRequest = null;
      
      try {
        await request.message.reply('Sorry, there was an error processing your request. Please try again.');
      } catch (replyError) {
        console.error('Failed to send error notification:', replyError);
      }
    } finally {
      if (this.processingQueue.length > 0) {
        setTimeout(() => this.processQueue(), 1000);
      } else {
        this.isProcessing = false;
        this.currentProcessingRequest = null;
      }
    }
  }

  async executeCommand(message, chat, prompt, isSearchCommand) {
    console.log(`[EXECUTE] Processing command: "${prompt.substring(0, 50)}..."`);
    
    try {
      const waMessages = await chat.fetchMessages({ limit: 50 });
      const metadata = await chat.groupMetadata;
      if (!metadata || !metadata.participants) {
        console.log(`[EXECUTE] No group metadata available.`);
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

      console.log(`[EXECUTE] Using ${newMessages.length} new messages (from ${currentMessages.length} total) for context`);

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
      
      console.log(`[EXECUTE] API response received`);
      await message.reply(response);
      console.log(`[EXECUTE] Reply sent successfully.`);

    } catch (error) {
      console.error(`[EXECUTE] Error in executeCommand:`, error);
      try {
        await message.reply('Sorry, there was an error processing your request. Please try again.');
      } catch (replyError) {
        console.error('Failed to send error reply:', replyError);
      }
    }
  }

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

    console.log(`[CACHE] Group ${groupId}: ${cachedMessages.length} cached, ${currentMessages.length} current, ${newMessages.length} new messages`);
    return newMessages;
  }

  getBotStatus() {
    if (this.client && this.client.info) return 'connected';
    if (this.hasLocalSession()) return 'session_exists';
    return 'disconnected';
  }

  async getSupabaseStatus() {
    try {
      if (!this.supabaseStore) {
        return {
          sessionsCount: 0,
          totalSizeMB: 0,
          lastCheck: new Date().toISOString(),
          status: 'store_not_initialized',
          storageType: 'Supabase PostgreSQL'
        };
      }

      const stats = await this.supabaseStore.getStorageStats();
      
      return {
        sessionsCount: stats.sessionsCount,
        totalSizeMB: stats.totalSizeMB,
        lastCheck: stats.lastUpdated,
        status: 'connected',
        storageType: 'Supabase PostgreSQL'
      };
    } catch (error) {
      return {
        sessionsCount: 0,
        totalSizeMB: 0,
        lastCheck: new Date().toISOString(),
        status: 'error',
        error: error.message,
        storageType: 'Supabase PostgreSQL'
      };
    }
  }

  async saveActiveGroupsToSupabase() {
    try {
      const { error } = await supabase
        .from('bot_settings')
        .upsert({
          key: 'active_groups',
          value: this.activeGroups,
        }, {
          onConflict: 'key'
        });

      if (error) throw error;

      console.log('Active groups saved to Supabase:', this.activeGroups);
    } catch (err) {
      console.error('Failed to save active groups to Supabase:', err);
    }
  }

  async loadActiveGroupsFromSupabase() {
    try {
      const { data, error } = await supabase
        .from('bot_settings')
        .select('value')
        .eq('key', 'active_groups')
        .single();

      if (error && error.code !== 'PGRST116') { // PGRST116 = no rows
        console.error('Error loading active groups from Supabase:', error);
        return;
      }

      if (data && data.value) {
        this.activeGroups = Array.isArray(data.value) ? data.value : [];
        console.log('Active groups loaded from Supabase:', this.activeGroups);
      } else {
        this.activeGroups = [];
        console.log('No active groups found in Supabase, starting empty');
      }

      this.emitToAllSockets('active-groups-updated', { groups: this.activeGroups });
    } catch (err) {
      console.error('Failed to load active groups from Supabase:', err);
      this.activeGroups = [];
    }
  }

  ensureAllDirectories() {
    try {
      this.ensureDirectoryExists(this.authPath);
      console.log('✅ Main auth directory ensured');
    } catch (error) {
      console.error('❌ Error creating directories:', error);
    }
  }

  async initializeBot() {
    if (this.isInitializing) {
      console.log('Bot is already initializing...');
      return;
    }
    this.isInitializing = true;

    try {
      console.log('🔄 Initializing bot with Supabase RemoteAuth...');

      this.supabaseStore = new SupabaseRemoteAuthStore('admin');
      
      if (await this.shouldForceQR()) {
        console.log('🔄 Forcing QR generation due to session recovery');
        await this.clearSession();
      }

      this.client = new Client({
        authStrategy: new RemoteAuth({
          clientId: 'admin',
          store: this.supabaseStore,
          backupSyncIntervalMs: 60000,
        }),
        puppeteer: {
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--max_old_space_size=512',
          ],
        },
        takeoverOnConflict: false,
        restartOnAuthFail: true,
      });

      this.setupClientEvents();
      await this.client.initialize();

    } catch (error) {
      console.error('❌ Error initializing bot:', error);
      
      if (this.isSessionError(error)) {
        console.log('🔄 Session error detected, attempting recovery...');
        await this.recoverFromSessionError(error);
      } else {
        this.emitToAllSockets('bot-error', { error: error.message });
        this.isInitializing = false;
      }
    }
  }

  setupClientEvents() {
    if (!this.client) return;

    let qrGenerated = false;

    this.client.on('qr', async (qr) => {
      console.log('🔶 QR code generated - scanning required');
      qrGenerated = true;
      
      this.sessionRecovery.currentRetries = 0;
      
      try {
        const qrImage = await QRCode.toDataURL(qr);
        this.currentQrCode = qrImage;
        this.emitToAllSockets('qr-code', { 
          qr: qrImage
        });
        this.emitToAllSockets('bot-status', { 
          status: 'scan_qr',
          retryCount: this.sessionRecovery.currentRetries,
          maxRetries: this.sessionRecovery.maxRetries
        });
        console.log('✅ QR code generated and sent to frontend');
      } catch (error) {
        console.error('❌ Error generating QR code:', error);
        this.emitToAllSockets('bot-error', { error: 'Failed to generate QR code' });
      }
    });

    this.client.on('loading_screen', (percent, message) => {
      console.log(`📱 Loading Screen: ${percent}% - ${message}`);
      this.emitToAllSockets('bot-status', { 
        status: 'loading', 
        percent, 
        message,
        retryCount: this.sessionRecovery.currentRetries,
        maxRetries: this.sessionRecovery.maxRetries
      });
    });

    this.client.on('authenticated', () => {
      console.log('✅ Bot authenticated with RemoteAuth');
      this.emitToAllSockets('bot-status', { 
        status: 'authenticated',
        retryCount: this.sessionRecovery.currentRetries,
        maxRetries: this.sessionRecovery.maxRetries
      });
      this.forceQR = false;
      this.sessionRecovery.currentRetries = 0;
    });

    this.client.on('ready', async () => {
      console.log('✅ Bot connected successfully with RemoteAuth');
      this.emitToAllSockets('bot-status', { 
        status: 'connected',
        retryCount: this.sessionRecovery.currentRetries,
        maxRetries: this.sessionRecovery.maxRetries
      });
      this.isInitializing = false;
      this.isWaitingForSession = false;
      this.sessionRetryAttempts = 0;
      this.forceQR = false;
      this.sessionRecovery.currentRetries = 0;
      this.sessionRecovery.lastSessionTime = Date.now();
      
      this.currentQrCode = null;
      await this.loadActiveGroupsFromSupabase();
      
      try {
        await this.checkSupabaseStorage();
      } catch (error) {
        console.log('Could not check Supabase storage after connection');
      }
      
      console.log('✅ Supabase RemoteAuth is automatically handling session persistence');
    });

    this.client.on('remote_session_saved', () => {
      console.log('💾 Session saved to remote store');
      this.emitToAllSockets('bot-status', { status: 'session_saved' });
    });

    this.client.on('auth_failure', (error) => {
      console.error('❌ Bot auth failed:', error);
      this.emitToAllSockets('bot-error', { 
        error: 'Authentication failed',
        retryCount: this.sessionRecovery.currentRetries,
        maxRetries: this.sessionRecovery.maxRetries
      });
      this.isInitializing = false;
    });

    this.client.on('disconnected', async (reason) => {
      console.log('🔌 Bot disconnected:', reason);
      this.emitToAllSockets('bot-status', { 
        status: 'disconnected',
        reason: reason,
        retryCount: this.sessionRecovery.currentRetries,
        maxRetries: this.sessionRecovery.maxRetries
      });
      this.client = null;
      this.isProcessing = false;
      
      this.groupsCache.data = [];
      this.groupsCache.lastUpdated = 0;
      this.processingQueue = [];
      this.currentProcessingRequest = null;
      this.groupCaches.clear();
      
      setTimeout(async () => {
        console.log('🔄 Attempting to restore session via RemoteAuth...');
        this.initializeBot();
      }, 5000);
    });

    this.client.on('message', async (message) => {
      await this.handleMessage(message);
    });
  }

  stopBot() {
    console.log('🛑 Stopping bot and cleaning up memory...');
    
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    
    this.isInitializing = false;
    this.processingQueue = [];
    this.isProcessing = false;
    this.currentProcessingRequest = null;
    this.groupCaches.clear();
    this.sessionRecovery.currentRetries = 0;
    
    console.log('✅ Bot stopped and memory cleaned up');
  }

  setActiveGroups(groups) {
    this.activeGroups = groups;
    this.saveActiveGroupsToSupabase();
    this.emitToAllSockets('active-groups-updated', { groups: groups });
    console.log('✅ Set active groups:', groups);
  }

  async handleMessage(message) {
    try {
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
    } catch (error) {
      console.error('Error in handleMessage:', error);
    }
  }

  isBotCommand(messageText) {
    const commands = ['!bot', '!ai', '@bot', 'bot,', '!ai_search'];
    return commands.some(cmd => messageText.toLowerCase().includes(cmd));
  }

  async callExternalAPI(payload) {
    const apiUrl = process.env.API_ENDPOINT;
    const generateEndpoint = `${apiUrl}/generate_real_time`;
    
    console.log(`[API] Calling: ${generateEndpoint}`);
    console.log(`[API] Sending ${payload.messages.length} messages`);

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
      console.error('API call failed:', error.message);
      return 'Sorry, there was an error processing your request. Please try again later.';
    }
  }

  async callExternalAPISearch(payload) {
    const apiUrl = process.env.API_ENDPOINT;
    const generateEndpoint = `${apiUrl}/generate_realtime_search`;

    console.log(`[API-SEARCH] Calling: ${generateEndpoint}`);

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
        responseText += `\n\n*Search Info:* Queried "${data.search_info.search_query}"`;
        if (data.search_info.articles_found) {
          responseText += `, found ${data.search_info.articles_found} articles`;
        }
      }
      
      return responseText;

    } catch (error) {
      console.error('Search API call failed:', error.message);
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

  clearGroupsCache() {
    this.groupsCache.data = [];
    this.groupsCache.lastUpdated = 0;
    console.log('✅ Groups cache cleared');
  }

  async clearSession() {
    try {
      if (this.supabaseStore) {
        await this.supabaseStore.delete({ session: 'RemoteAuth-admin' });
        console.log('✅ Session cleared from Supabase');
      }
      
      this.sessionRecovery.currentRetries = 0;
      this.sessionRecovery.lastSessionTime = null;
      
    } catch (error) {
      console.error('❌ Error clearing Supabase session:', error);
    }
  }

  async forceQRGeneration() {
    console.log('🔄 Force QR generation requested...');
    this.forceQR = true;
    this.sessionRecovery.currentRetries = this.sessionRecovery.maxRetries;
    
    await this.clearSession();
    
    if (this.client) {
      try {
        await this.client.destroy();
        console.log('✅ Client destroyed');
      } catch (error) {
        console.error('Error destroying client:', error);
      }
      this.client = null;
    }
    
    this.isInitializing = false;
    this.isWaitingForSession = false;
    
    setTimeout(() => {
      console.log('🔄 Reinitializing bot for QR generation...');
      this.initializeBot();
    }, 2000);
    
    return true;
  }

  async manualPurgeSessions(fullPurge = false) {
    console.log(`🔧 Manual Supabase purge requested (full: ${fullPurge})`);
    return await this.purgeSupabaseSessions(fullPurge);
  }

  async purgeSupabaseSessions(fullPurge = false) {
    try {
      console.log('🧹 Purging Supabase sessions...');
      
      if (!this.supabaseStore) {
        return { success: false, error: 'Supabase store not initialized' };
      }
      
      if (fullPurge) {
        const sessions = await this.supabaseStore.list();
        let deletedCount = 0;
        
        for (const session of sessions) {
          const baseSession = session.id.replace('admin-', '');
          await this.supabaseStore.delete({ session: baseSession });
          deletedCount++;
        }
        
        this.supabaseMonitor.lastPurgeTime = Date.now();
        
        return {
          success: true,
          deletedCount,
          message: `Deleted ${deletedCount} sessions from Supabase`,
          forceFullPurge: true
        };
      } else {
        const deletedCount = await this.supabaseStore.cleanupOldSessions(24);
        
        this.supabaseMonitor.lastPurgeTime = Date.now();
        
        return {
          success: true,
          deletedCount,
          message: `Cleaned up ${deletedCount} old sessions`,
          forceFullPurge: false
        };
      }
    } catch (error) {
      console.error('❌ Error purging Supabase sessions:', error);
      return {
        success: false,
        error: error.message,
        deletedCount: 0,
        forceFullPurge: false
      };
    }
  }

  getSessionRecoveryStatus() {
    return {
      currentRetries: this.sessionRecovery.currentRetries,
      maxRetries: this.sessionRecovery.maxRetries,
      lastSessionTime: this.sessionRecovery.lastSessionTime,
      sessionAge: this.sessionRecovery.lastSessionTime ? 
        Date.now() - this.sessionRecovery.lastSessionTime : null
    };
  }

  getFullStatus() {
    return {
      botStatus: this.getBotStatus(),
      qrCode: this.currentQrCode,
      recoveryStatus: this.getSessionRecoveryStatus(),
      supabase: this.getSupabaseStatus(),
      activeGroupsCount: this.activeGroups.length,
      queueLength: this.processingQueue.length,
      isProcessing: this.isProcessing,
      memoryUsage: {
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
      }
    };
  }

  addSocketConnection(socket) {
    this.socketConnections.push(socket);
    console.log('Socket connection added. Total connections:', this.socketConnections.length);
    
    this.emitToAllSockets('bot-status', { 
      status: this.getBotStatus(),
      qrCode: this.currentQrCode,
      recoveryStatus: this.getSessionRecoveryStatus(),
      fullStatus: this.getFullStatus()
    });
    
    this.emitToAllSockets('active-groups-updated', { groups: this.activeGroups });
  }

  removeSocketConnection(socket) {
    this.socketConnections = this.socketConnections.filter(s => s !== socket);
    console.log('Socket connection removed. Total connections:', this.socketConnections.length);
  }

  emitToAllSockets(event, data) {
    this.socketConnections.forEach(socket => {
      try {
        socket.emit(event, data);
      } catch (error) {
        console.error('Error emitting to socket:', error);
      }
    });
  }
}

export default BotManager;