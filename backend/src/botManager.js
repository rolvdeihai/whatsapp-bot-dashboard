// whatsapp-bot-dashboard/backend/src/botManager.js

import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg; // Switch back to LocalAuth
import QRCode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import axios from 'axios';
import SupabaseSessionStorage from './SupabaseSessionStorage.js';
import archiver from 'archiver';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class BotManager {
  constructor() {
    this.client = null;
    this.activeGroups = [];
    this.socketConnections = [];
    this.isInitializing = false;
    this.currentQrCode = null;
    
    // Use LocalAuth directory
    this.authPath = process.env.NODE_ENV === 'production' 
      ? '/tmp/whatsapp-auth' 
      : path.join(__dirname, '../auth');
    
    this.cacheDir = process.env.NODE_ENV === 'production'
      ? '/tmp/whatsapp-cache'
      : path.join(__dirname, '../group_cache');
    
    this.ensureDirectoryExists(this.authPath);
    this.ensureDirectoryExists(this.cacheDir);

    this.store = new SupabaseSessionStorage();

    // Group caching with lazy loading
    this.groupsCache = {
      data: [],
      lastUpdated: 0,
      cacheDuration: 5 * 60 * 1000,
      isUpdating: false
    };
    
    // Global queue with limits
    this.processingQueue = [];
    this.isProcessing = false;
    this.currentProcessingRequest = null;
    this.maxQueueSize = 10;
    
    // Rate limiting
    this.lastCommandTime = 0;
    this.minCommandInterval = 3000;
    
    // In-memory cache with limits
    this.groupCaches = new Map();
    this.maxCachedGroups = 5;
    this.maxCachedMessages = 30;

    this.sessionRetryAttempts = 0;
    this.maxSessionRetries = 3;
    this.isWaitingForSession = false;
    this.forceQR = false;
    
    this.startMemoryMonitoring();
    this.loadActiveGroupsFromDisk();
    this.initializeBot();
  }

  // Safe directory creation
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

  // Memory monitoring system
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

  // Quick group fetch with limits
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

  // Search groups by name
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

  // Get only saved groups
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

  // Queue system
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

  // Command execution
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

  // In-memory message diffing
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

  // Check for local session files
  hasLocalSession() {
    try {
      const sessionPath = path.join(this.authPath, 'session-admin');
      if (fs.existsSync(sessionPath)) {
        const files = fs.readdirSync(sessionPath);
        
        // More flexible session detection
        const hasSessionFiles = files.some(file => 
          file.includes('session') || 
          file.endsWith('.json') || 
          file === 'wwebjs.browserid' ||
          file === 'wwebjs.session.json' ||
          file === 'Default' || // Main browser profile
          file.includes('Local Storage') || // Check subdirectories too
          file.includes('IndexedDB')
        );
        
        console.log(`Local session files: ${files.join(', ')}`);
        console.log(`Session detection result: ${hasSessionFiles}`);
        
        // Additional check: if Default exists, check if it has content
        if (files.includes('Default')) {
          const defaultPath = path.join(sessionPath, 'Default');
          if (fs.existsSync(defaultPath)) {
            const defaultFiles = fs.readdirSync(defaultPath);
            console.log(`Default directory contents: ${defaultFiles.join(', ')}`);
            // If Default has essential browser files, consider it a valid session
            const hasBrowserFiles = defaultFiles.some(f => 
              f === 'Local Storage' || f === 'IndexedDB' || f === 'Cookies'
            );
            if (hasBrowserFiles) {
              console.log('Valid browser session files found');
              return true;
            }
          }
        }
        
        return hasSessionFiles;
      }
      return false;
    } catch (error) {
      console.error('Error checking local session:', error);
      return false;
    }
  }

  // Prioritize local session, fallback to Supabase
  async hasSession() {
    try {
      const hasLocal = this.hasLocalSession();
      if (hasLocal) {
        console.log('Using local session');
        return true;
      }
      
      const hasSupabaseSession = await this.store.sessionExists('admin');
      console.log(`Supabase session check: ${hasSupabaseSession}`);
      
      if (hasSupabaseSession) {
        console.log('Supabase session found, will restore to local on next startup');
        return true;
      }
      
      return false;
    } catch (error) {
      console.error('Error checking session:', error);
      return false;
    }
  }
  
  // ──────────────────────────────────────────────────────────────────────
  //  ONLY THE CHANGED PARTS – paste them over the original methods
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Zip ONLY the files that are required for a WhatsApp-Web session.
   *   • Cookies
   *   • Local Storage/leveldb/*
   *   • IndexedDB/https_web.whatsapp.com_0.indexeddb.leveldb/*
   *
   * All other folders (Cache, GPUCache, Code Cache, logs, …) are excluded.
   */
  async syncSessionToSupabase() {
    try {
      console.log('Zipping COMPLETE session directory for Supabase...');

      const sessionPath = path.join(this.authPath, 'session-admin');
      if (!fs.existsSync(sessionPath)) {
        console.log('No session directory found');
        return false;
      }

      // Create a complete copy of the session directory
      const tempPath = path.join(this.authPath, 'temp-session-admin');
      if (fs.existsSync(tempPath)) {
        await fs.remove(tempPath);
      }
      await fs.copy(sessionPath, tempPath);
      console.log('Created complete temp copy of session');

      const zipPath = path.join(this.authPath, 'session-backup.zip');
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { 
        zlib: { level: 9 } 
      });

      let totalSize = 0;
      const MAX_ZIP_SIZE = 45 * 1024 * 1024; // 45 MB

      return new Promise((resolve) => {
        output.on('close', async () => {
          const finalSize = archive.pointer();
          console.log(`Complete session ZIP created: ${(finalSize/1024/1024).toFixed(2)} MB`);

          try {
            const zipBuffer = await fs.readFile(zipPath);

            if (finalSize > 40 * 1024 * 1024) {
              console.log('Large session ZIP -> uploading in chunks...');
              const success = await this.uploadInChunks(zipBuffer);
              resolve(success);
            } else {
              const fileName = `session-admin-complete-${Date.now()}.zip`;
              const filePath = `backups/${fileName}`;

              const { error } = await this.store.supabase.storage
                .from('whatsapp-sessions')
                .upload(filePath, zipBuffer, { 
                  upsert: true,
                  contentType: 'application/zip'
                });

              if (error) throw error;

              // Save metadata with complete session indicator
              await this.store.save({
                session: 'admin',
                data: { 
                  session_zip_path: filePath, 
                  last_sync: new Date().toISOString(),
                  is_complete_session: true,
                  sync_version: '2.0'
                }
              });

              console.log(`Complete session uploaded: ${fileName}`);
              resolve(true);
            }
          } catch (e) {
            console.error('Upload failed:', e);
            resolve(false);
          } finally {
            // Cleanup
            await fs.remove(tempPath).catch(() => {});
            await fs.remove(zipPath).catch(() => {});
          }
        });

        archive.on('error', (err) => {
          console.error('Archive error:', err);
          resolve(false);
        });

        archive.on('warning', (err) => {
          if (err.code === 'ENOENT') {
            console.warn('Archive warning:', err);
          } else {
            throw err;
          }
        });

        archive.pipe(output);

        // Add ALL files from the session directory recursively
        // This ensures we capture everything WhatsApp Web.js needs
        archive.directory(tempPath, false);

        archive.finalize();
      });
    } catch (e) {
      console.error('Complete session sync error:', e);
      return false;
    }
  }

  async uploadInChunks(zipBuffer) {
    try {
      const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB chunks
      const totalChunks = Math.ceil(zipBuffer.length / CHUNK_SIZE);
      const sessionId = `session-admin-${Date.now()}`;
      const chunkPaths = [];

      console.log(`Uploading ${totalChunks} chunks...`);

      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, zipBuffer.length);
        const chunk = zipBuffer.slice(start, end);

        const chunkName = `${sessionId}-chunk-${i.toString().padStart(3, '0')}.bin`;
        const chunkPath = `chunks/${chunkName}`;

        const { error } = await this.store.supabase.storage
          .from('whatsapp-sessions')
          .upload(chunkPath, chunk);

        if (error) throw error;

        chunkPaths.push(chunkPath);
        console.log(`Uploaded chunk ${i + 1}/${totalChunks}`);
      }

      // Save chunk metadata
      await this.store.save({
        session: 'admin',
        data: {
          session_chunks: chunkPaths,
          is_chunked: true,
          total_chunks: totalChunks,
          last_sync: new Date().toISOString(),
          is_complete_session: true,
          sync_version: '2.0'
        }
      });

      console.log('All chunks uploaded successfully');
      return true;
    } catch (error) {
      console.error('Chunk upload failed:', error);
      return false;
    }
  }

  /**
   * Restore the *filtered* ZIP that we uploaded.
   * The ZIP contains only the three authentication folders, so extraction is tiny.
   */
  async restoreSessionFromSupabase() {
    try {
      console.log('Restoring COMPLETE session from Supabase...');
      
      const sessionData = await this.store.extract('admin');
      if (!sessionData) {
        console.log('No session data found in Supabase');
        return false;
      }

      const sessionPath = path.join(this.authPath, 'session-admin');
      
      // Clear existing session completely
      if (fs.existsSync(sessionPath)) {
        await fs.remove(sessionPath);
        console.log('Cleared existing session directory');
      }
      
      this.ensureDirectoryExists(sessionPath);

      let zipBuffer;

      if (sessionData.is_chunked && sessionData.session_chunks) {
        console.log('Reassembling from chunks...');
        zipBuffer = await this.downloadAndAssembleChunks(sessionData.session_chunks);
      } else if (sessionData.session_zip_path) {
        const { data, error } = await this.store.supabase.storage
          .from('whatsapp-sessions')
          .download(sessionData.session_zip_path);
        if (error) throw error;
        zipBuffer = Buffer.from(await data.arrayBuffer());
      } else {
        console.log('No valid session path found');
        return false;
      }

      if (!zipBuffer || zipBuffer.length === 0) {
        console.log('Empty zip buffer');
        return false;
      }

      const zipPath = path.join(this.authPath, 'restore.zip');
      await fs.writeFile(zipPath, zipBuffer);

      // Extract complete session
      const AdmZip = (await import('adm-zip')).default;
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(sessionPath, true);

      await fs.remove(zipPath);
      
      // Verify the restored session structure
      const hasValidSession = await this.verifySessionStructure(sessionPath);
      
      if (hasValidSession) {
        console.log('Complete session restored and verified successfully');
        return true;
      } else {
        console.log('Restored session structure is invalid');
        return false;
      }
      
    } catch (e) {
      console.error('Complete session restore failed:', e);
      return false;
    }
  }

  async restoreSessionWithRetry() {
    console.log('Starting session restoration with retry capability...');
    
    this.isWaitingForSession = true;
    this.emitToAllSockets('bot-status', { status: 'waiting_for_session' });
    
    for (let attempt = 1; attempt <= this.maxSessionRetries; attempt++) {
      console.log(`Session restoration attempt ${attempt}/${this.maxSessionRetries}`);
      
      try {
        const restored = await this.restoreSessionFromSupabase();
        
        if (restored) {
          console.log(`Session successfully restored on attempt ${attempt}`);
          this.isWaitingForSession = false;
          this.sessionRetryAttempts = 0;
          return true;
        }
        
        // If restoration failed, wait before retry
        if (attempt < this.maxSessionRetries) {
          console.log(`Session restoration failed, retrying in 10 seconds...`);
          this.emitToAllSockets('bot-status', { 
            status: 'session_retry', 
            attempt: attempt,
            maxAttempts: this.maxSessionRetries
          });
          
          await new Promise(resolve => setTimeout(resolve, 10000));
        }
      } catch (error) {
        console.error(`Session restoration attempt ${attempt} failed:`, error);
        
        if (attempt < this.maxSessionRetries) {
          this.emitToAllSockets('bot-status', { 
            status: 'session_retry', 
            attempt: attempt,
            maxAttempts: this.maxSessionRetries,
            error: error.message
          });
          await new Promise(resolve => setTimeout(resolve, 10000));
        }
      }
    }
    
    console.log('All session restoration attempts failed');
    this.isWaitingForSession = false;
    this.sessionRetryAttempts = 0;
    this.emitToAllSockets('bot-status', { status: 'session_restore_failed' });
    return false;
  }

  async forceQRGeneration() {
    console.log('Force QR generation requested...');
    this.forceQR = true;
    
    // Clear existing session
    const sessionPath = path.join(this.authPath, 'session-admin');
    if (fs.existsSync(sessionPath)) {
      await fs.remove(sessionPath);
      console.log('Session cleared for forced QR generation');
    }
    
    // Stop current client
    if (this.client) {
      await this.client.destroy();
      this.client = null;
    }
    
    this.isInitializing = false;
    this.isWaitingForSession = false;
    
    // Reinitialize to generate QR
    setTimeout(() => {
      this.initializeBot();
    }, 2000);
    
    return true;
  }

  async forceRetryConnection() {
    console.log('Force retry connection requested...');
    
    // If we're stuck initializing, force stop and restart
    if (this.isInitializing) {
      console.log('Force stopping current initialization...');
      
      // Destroy client if it exists
      if (this.client) {
        try {
          await this.client.destroy();
          console.log('Client destroyed during force retry');
        } catch (error) {
          console.error('Error destroying client during force retry:', error);
        }
        this.client = null;
      }
      
      // Reset initialization flags
      this.isInitializing = false;
      this.isWaitingForSession = false;
      
      // Clear any existing QR
      this.currentQrCode = null;
      
      // Wait a moment then restart
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      console.log('Restarting bot after force retry...');
      await this.initializeBot();
      
      return true;
    }
    
    // If not initializing but stuck, just reinitialize
    console.log('Bot not initializing - performing fresh start...');
    await this.initializeBot();
    return true;
  }

  async downloadAndAssembleChunks(chunkPaths) {
    try {
      const chunks = [];
      for (const chunkPath of chunkPaths) {
        const { data, error } = await this.store.supabase.storage
          .from('whatsapp-sessions')
          .download(chunkPath);
        if (error) {
          console.error(`Failed to download chunk ${chunkPath}:`, error);
          continue;
        }
        chunks.push(Buffer.from(await data.arrayBuffer()));
      }
      return Buffer.concat(chunks);
    } catch (error) {
      console.error('Chunk assembly failed:', error);
      return null;
    }
  }

  async verifySessionStructure(sessionPath) {
    try {
      if (!fs.existsSync(sessionPath)) return false;

      const files = fs.readdirSync(sessionPath);
      console.log('Restored session contents:', files);

      // Check for essential directories
      const hasDefaultDir = files.includes('Default');
      const hasWwebjsFiles = files.some(f => f.includes('wwebjs'));
      
      if (hasDefaultDir) {
        const defaultPath = path.join(sessionPath, 'Default');
        const defaultFiles = fs.readdirSync(defaultPath);
        console.log('Default directory contents:', defaultFiles);

        // Check for critical browser files
        const hasCookies = defaultFiles.includes('Cookies');
        const hasLocalStorage = defaultFiles.some(f => f.includes('Local Storage'));
        const hasIndexedDB = defaultFiles.some(f => f.includes('IndexedDB'));
        
        const isValid = hasCookies && (hasLocalStorage || hasIndexedDB);
        console.log(`Session verification: Cookies=${hasCookies}, LocalStorage=${hasLocalStorage}, IndexedDB=${hasIndexedDB}, Valid=${isValid}`);
        
        return isValid;
      }
      
      return hasWwebjsFiles;
    } catch (error) {
      console.error('Session verification failed:', error);
      return false;
    }
  }

  // Bot status
  getBotStatus() {
    if (this.client && this.client.info) return 'connected';
    if (this.hasLocalSession() || this.hasSession()) return 'session_exists';
    return 'disconnected';
  }

  // Active groups persistence
  saveActiveGroupsToDisk() {
    try {
      const dataPath = path.join(this.authPath, 'activeGroups.json');
      fs.writeFileSync(dataPath, JSON.stringify(this.activeGroups, null, 2));
      console.log('Active groups saved to disk:', this.activeGroups);
    } catch (error) {
      console.error('Error saving active groups:', error);
    }
  }

  loadActiveGroupsFromDisk() {
    try {
      const dataPath = path.join(this.authPath, 'activeGroups.json');
      if (fs.existsSync(dataPath)) {
        const data = fs.readFileSync(dataPath, 'utf8');
        this.activeGroups = JSON.parse(data);
        console.log('Active groups loaded from disk:', this.activeGroups);
      }
    } catch (error) {
      console.error('Error loading active groups:', error);
      this.activeGroups = [];
    }
  }

  // Bot initialization with LocalAuth
  async initializeBot() {
    if (this.isInitializing) {
      console.log('Bot is already initializing...');
      return;
    }

    this.isInitializing = true;
    
    try {
      console.log('Initializing bot with enhanced session handling...');
      
      const hasLocalSession = this.hasLocalSession();
      console.log(`Local session check: ${hasLocalSession}`);
      
      // If force QR is requested, skip session restoration
      if (this.forceQR) {
        console.log('Force QR mode - skipping session restoration');
        this.forceQR = false; // Reset for next time
      } else if (!hasLocalSession) {
        console.log('No local session found, checking Supabase...');
        const hasSupabaseSession = await this.hasSession();
        console.log(`Supabase session check: ${hasSupabaseSession}`);
        
        if (hasSupabaseSession) {
          // Use enhanced session restoration with retry
          const restored = await this.restoreSessionWithRetry();
          if (restored) {
            console.log('Session restored successfully, proceeding with authentication...');
            this.emitToAllSockets('bot-status', { status: 'authenticating_with_session' });
          } else {
            console.log('Session restoration failed, will require QR scan');
            this.emitToAllSockets('bot-status', { status: 'session_restore_failed' });
          }
        } else {
          console.log('No session found anywhere, will require QR scan');
        }
      } else {
        console.log('Using existing local session');
        this.emitToAllSockets('bot-status', { status: 'authenticating_with_session' });
      }
      
      // Create client (will use session if available)
      this.client = new Client({
        authStrategy: new LocalAuth({
          clientId: 'admin',
          dataPath: this.authPath
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
            '--single-process',
            '--disable-gpu',
          ],
        },
        takeoverOnConflict: false,
        takeoverTimeoutMs: 30000,
        restartOnAuthFail: false,
        qrMaxRetries: 2, // Reduced since we have our own retry logic
      });

      this.setupClientEvents();
      await this.client.initialize();
      
    } catch (error) {
      console.error('Error initializing bot:', error);
      this.emitToAllSockets('bot-error', { error: error.message });
      this.isInitializing = false;
      this.isWaitingForSession = false;
    }
  }

  // Client event setup
  setupClientEvents() {
    if (!this.client) return;

    let qrGenerated = false;
    let sessionCheckAfterQR = false;

    this.client.on('qr', async (qr) => {
      // If we're waiting for session and QR is generated, check if we should retry
      if (this.isWaitingForSession && !this.forceQR) {
        console.log('QR generated while waiting for session - checking if we should retry...');
        
        // One final session check before showing QR
        const hasValidSession = this.hasLocalSession();
        if (hasValidSession && this.sessionRetryAttempts < this.maxSessionRetries) {
          console.log('Valid session found after QR - retrying authentication...');
          this.sessionRetryAttempts++;
          
          this.emitToAllSockets('bot-status', { 
            status: 'session_retry_after_qr',
            attempt: this.sessionRetryAttempts,
            maxAttempts: this.maxSessionRetries
          });
          
          // Destroy and recreate client to force session usage
          try {
            await this.client.destroy();
            this.client = null;
            this.isInitializing = false;
            
            // Wait then reinitialize
            setTimeout(() => {
              this.initializeBot();
            }, 5000);
          } catch (error) {
            console.error('Error during session retry:', error);
          }
          return;
        }
      }

      // If we get here, show the QR code
      console.log('QR code generated - scanning required');
      qrGenerated = true;
      
      try {
        const qrImage = await QRCode.toDataURL(qr);
        this.currentQrCode = qrImage;
        this.emitToAllSockets('qr-code', { 
          qr: qrImage,
          canUseSession: this.hasLocalSession() && !this.forceQR
        });
        this.emitToAllSockets('bot-status', { status: 'scan_qr' });
        console.log('QR code generated and sent to frontend');
      } catch (error) {
        console.error('Error generating QR code:', error);
        this.emitToAllSockets('bot-error', { error: 'Failed to generate QR code' });
      }
    });

    this.client.on('loading_screen', (percent, message) => {
      console.log(`Loading Screen: ${percent}% - ${message}`);
      
      // If we have a valid session and loading is happening, we're authenticating
      if (this.hasLocalSession() && percent > 0 && !qrGenerated) {
        this.emitToAllSockets('bot-status', { status: 'authenticating_with_session' });
      }
    });

    this.client.on('authenticated', () => {
      console.log('Bot authenticated with LocalAuth');
      this.emitToAllSockets('bot-status', { status: 'authenticated' });
      this.forceQR = false; // Reset force QR flag
    });

    this.client.on('ready', async () => {
      console.log('Bot connected successfully with LocalAuth');
      this.emitToAllSockets('bot-status', { status: 'connected' });
      this.isInitializing = false;
      this.isWaitingForSession = false;
      this.sessionRetryAttempts = 0;
      this.forceQR = false;
      
      // Clear QR code
      this.currentQrCode = null;
      
      // Sync session to Supabase
      setTimeout(async () => {
        try {
          const syncSuccess = await this.syncSessionToSupabase();
          if (syncSuccess) {
            console.log('Session successfully synced to Supabase');
          }
        } catch (syncError) {
          console.error('Session sync error:', syncError);
        }
      }, 5000);
    });

    this.client.on('auth_failure', (error) => {
      console.error('Bot auth failed:', error);
      this.emitToAllSockets('bot-error', { error: 'Authentication failed' });
      this.isInitializing = false;
    });

    this.client.on('disconnected', async (reason) => {
      console.log('Bot disconnected:', reason);
      this.emitToAllSockets('bot-status', { status: 'disconnected' });
      this.client = null;
      this.isProcessing = false;
      
      // Clear memory
      this.groupsCache.data = [];
      this.groupsCache.lastUpdated = 0;
      this.processingQueue = [];
      this.currentProcessingRequest = null;
      this.groupCaches.clear();
      
      // Restore from Supabase if local session lost
      setTimeout(async () => {
        console.log('Attempting to restore session...');
        const hasLocalSession = this.hasLocalSession();
        if (!hasLocalSession) {
          console.log('No local session found, attempting to restore from Supabase...');
          const restored = await this.restoreSessionFromSupabase();
          if (restored) {
            console.log('Session restored from Supabase, reinitializing...');
          }
        }
        this.initializeBot();
      }, 5000);
    });

    this.client.on('message', async (message) => {
      await this.handleMessage(message);
    });
  }

  // Stop bot with cleanup
  stopBot() {
    console.log('Stopping bot and cleaning up memory...');
    
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    
    this.isInitializing = false;
    this.processingQueue = [];
    this.isProcessing = false;
    this.currentProcessingRequest = null;
    this.groupCaches.clear();
    
    console.log('Bot stopped and memory cleaned up');
  }

  setActiveGroups(groups) {
    this.activeGroups = groups;
    this.saveActiveGroupsToDisk();
    this.emitToAllSockets('active-groups-updated', { groups: groups });
    console.log('Set active groups:', groups);
  }

  // Message handling
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

  // API calls
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
    console.log('Groups cache cleared');
  }

  // Clear both local and Supabase sessions
  async clearSupabaseSession() {
    try {
      const sessionPath = path.join(this.authPath, 'session-admin');
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        console.log('Local session cleared');
      }
      
      await this.store.delete('admin');
      console.log('Supabase session cleared');
      
    } catch (error) {
      console.error('Error clearing sessions:', error);
    }
  }

  // Manual session backup
  async backupSession() {
    try {
      console.log('Manual session backup requested...');
      const success = await this.syncSessionToSupabase();
      return {
        success,
        message: success ? 
          'Session successfully backed up to Supabase' : 
          'Session backup failed'
      };
    } catch (error) {
      console.error('Manual backup failed:', error);
      return { success: false, message: 'Backup failed: ' + error.message };
    }
  }

  // Manual session restore
  async restoreSession() {
    try {
      console.log('Manual session restore requested...');
      const success = await this.restoreSessionFromSupabase();
      return {
        success,
        message: success ? 
          'Session restored from Supabase. Please restart the bot.' : 
          'Session restore failed - no valid session in Supabase'
      };
    } catch (error) {
      console.error('Manual restore failed:', error);
      return { success: false, message: 'Restore failed: ' + error.message };
    }
  }

  // Socket management
  addSocketConnection(socket) {
    this.socketConnections.push(socket);
    console.log('Socket connection added. Total connections:', this.socketConnections.length);
    
    this.emitToAllSockets('bot-status', { 
      status: this.getBotStatus(),
      qrCode: this.currentQrCode
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