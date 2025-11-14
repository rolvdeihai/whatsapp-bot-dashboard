// backend/src/botManager.js
import pkg from 'whatsapp-web.js';
const { Client, RemoteAuth } = pkg;
import QRCode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import axios from 'axios';
import SupabaseSessionStorage from './SupabaseSessionStorage.js';
import archiver from 'archiver';
import { setTimeout as wait } from 'timers/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class BotManager {
  constructor(options = {}) {
    // Basic runtime state
    this.client = null;
    this.activeGroups = [];
    this.socketConnections = [];
    this.isInitializing = false;

    // Session/restore state
    this.isRestoring = false;
    this.isHydrated = false; // set true after we've verified local session is stable
    this.currentQrCode = null;
    this.forceQR = false;

    // Local paths
    this.authPath = process.env.NODE_ENV === 'production'
      ? path.join(process.cwd(), 'auth')
      : path.join(__dirname, '../auth');

    this.cacheDir = process.env.NODE_ENV === 'production'
      ? '/tmp/group_cache'
      : path.join(__dirname, '../group_cache');

    this.ensureDirectoryExists(this.authPath);
    this.ensureDirectoryExists(this.cacheDir);

    // External storage adapter
    this.store = new SupabaseSessionStorage();

    // Queues, caches, limits
    this.processingQueue = [];
    this.isProcessing = false;
    this.currentProcessingRequest = null;
    this.maxQueueSize = options.maxQueueSize || 10;

    this.lastCommandTime = 0;
    this.minCommandInterval = 3000;

    this.groupCaches = new Map();
    this.maxCachedGroups = 5;
    this.maxCachedMessages = 30;

    // Retry/session control
    this.sessionRetryAttempts = 0;
    this.maxSessionRetries = 3;
    this.sessionRestoreTimeoutMs = 30 * 1000; // 30s to restore and hydrate before fallback
    this.restorePollIntervalMs = 750; // polling while waiting for files to stabilize

    // Memory monitoring for low-RAM environments
    this.startMemoryMonitoring();

    // load persisted active groups
    this.loadActiveGroupsFromDisk();

    // Start the bot (non-blocking)
    // Hybrid strategy: attempt restore, but fallback to QR
    this.initializeBot();
  }

  // -------------------------
  // Utilities
  // -------------------------
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
    setInterval(() => this.checkMemoryUsage(), 30 * 1000);
  }

  checkMemoryUsage() {
    try {
      const used = process.memoryUsage();
      const usedMB = Math.round(used.heapUsed / 1024 / 1024);
      const totalMB = Math.round(used.heapTotal / 1024 / 1024);
      console.log(`Memory usage: ${usedMB}MB / ${totalMB}MB`);
      if (usedMB > 200) {
        console.log('High memory usage detected, performing cleanup...');
        this.performMemoryCleanup();
      }
    } catch (e) {
      console.error('Memory monitor error:', e);
    }
  }

  performMemoryCleanup() {
    try {
      if (this.processingQueue.length > this.maxQueueSize) {
        console.log(`Trimming queue from ${this.processingQueue.length} to ${this.maxQueueSize}`);
        this.processingQueue = this.processingQueue.slice(0, this.maxQueueSize);
      }
      if (this.groupCaches.size > this.maxCachedGroups) {
        const entries = Array.from(this.groupCaches.entries());
        const keep = entries.slice(-this.maxCachedGroups);
        this.groupCaches = new Map(keep);
        console.log(`Cleared group caches, kept ${keep.length}`);
      }
      if (global.gc) {
        global.gc();
        console.log('Forced garbage collection');
      }
    } catch (e) {
      console.error('Error during performMemoryCleanup:', e);
    }
  }

  // -------------------------
  // Local session detection (improved)
  // -------------------------
  /**
   * Check local RemoteAuth-admin folder for a plausible session.
   * We consider a session valid if:
   * - folder exists
   * - contains >= minFilesThreshold files
   * - contains at least one .json or session-like file
   *
   * This is intentionally conservative: we don't delete or assume validity only by count.
   */
  hasLocalSession(minFilesThreshold = 4) {
    try {
      const sessionPath = path.join(this.authPath, 'RemoteAuth-admin');
      if (!fs.existsSync(sessionPath)) return false;

      const files = fs.readdirSync(sessionPath).filter(f => !f.startsWith('.'));
      console.log(`Local RemoteAuth session files: ${files.length} files`);
      if (files.length < minFilesThreshold) return false;

      // quick check for json / session-like file names
      const hasJsonLike = files.some(f => /\.(json|db|data|session|credentials)/i.test(f));
      return hasJsonLike;
    } catch (error) {
      console.error('Error checking local session:', error);
      return false;
    }
  }

  // wait until the RemoteAuth directory's file listing stabilizes (no changes) or timeout
  async waitForSessionHydration(timeoutMs = 15000, pollIntervalMs = 750) {
    const sessionPath = path.join(this.authPath, 'RemoteAuth-admin');
    const deadline = Date.now() + timeoutMs;
    let lastFiles = null;
    let stableCount = 0;
    while (Date.now() < deadline) {
      // If folder doesn't exist yet, short sleep
      if (!fs.existsSync(sessionPath)) {
        await wait(pollIntervalMs);
        continue;
      }
      const files = fs.readdirSync(sessionPath).filter(f => !f.startsWith('.'));
      const filesKey = files.join(',');
      if (filesKey === lastFiles) {
        stableCount++;
        // if stable for two consecutive checks we consider it hydrated
        if (stableCount >= 2 && files.length > 0) {
          // heuristic: must contain some json/session files
          const hasJsonLike = files.some(f => /\.(json|db|data|session|credentials)/i.test(f));
          if (hasJsonLike) {
            this.isHydrated = true;
            return true;
          }
        }
      } else {
        stableCount = 0;
        lastFiles = filesKey;
      }
      await wait(pollIntervalMs);
    }
    // Timed out
    return false;
  }

  // -------------------------
  // Groups & queue helpers (kept from original)
  // -------------------------
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

  // -------------------------
  // Queue logic (kept)
  // -------------------------
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
        await request.message.reply(waitMessage);
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

  // -------------------------
  // Command execution (kept)
  // -------------------------
  async executeCommand(message, chat, prompt, isSearchCommand) {
    console.log(`[EXECUTE] Processing command: "${(prompt || '').substring(0, 50)}..."`);
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
          prompt,
          groupName: chat.name,
          sender: senderFormatted,
          timestamp: new Date().toISOString(),
          totalMessageCount: currentMessages.length,
          newMessageCount: newMessages.length
        });
      } else {
        response = await this.callExternalAPI({
          messages: newMessages,
          prompt,
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

  // -------------------------
  // Session backup / restore helpers (kept, minor fixes)
  // -------------------------
  async syncSessionToSupabase() {
    try {
      console.log('Zipping RemoteAuth session directory for Supabase...');
      const sessionPath = path.join(this.authPath, 'RemoteAuth-admin');
      if (!fs.existsSync(sessionPath)) {
        console.log('No RemoteAuth session directory found');
        return false;
      }

      const tempPath = path.join(this.authPath, 'temp-remoteauth-admin');
      if (fs.existsSync(tempPath)) await fs.remove(tempPath);
      await fs.copy(sessionPath, tempPath);
      console.log('Created temp copy of RemoteAuth session');

      const zipPath = path.join(this.authPath, 'remoteauth-session-backup.zip');
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      return new Promise((resolve) => {
        output.on('close', async () => {
          const finalSize = archive.pointer();
          console.log(`RemoteAuth session ZIP created: ${(finalSize / 1024 / 1024).toFixed(2)} MB`);
          try {
            const zipBuffer = await fs.readFile(zipPath);
            if (finalSize > 40 * 1024 * 1024) {
              console.log('Large session ZIP -> uploading in chunks...');
              const success = await this.uploadInChunks(zipBuffer);
              resolve(success);
            } else {
              const fileName = `remoteauth-admin-${Date.now()}.zip`;
              const filePath = `backups/${fileName}`;
              const { error } = await this.store.supabase.storage
                .from('whatsapp-sessions')
                .upload(filePath, zipBuffer, {
                  upsert: true,
                  contentType: 'application/zip'
                });
              if (error) throw error;
              await this.store.save({
                session: 'admin',
                data: {
                  session_zip_path: filePath,
                  last_sync: new Date().toISOString(),
                  is_remoteauth: true,
                  sync_version: '3.0'
                }
              });
              console.log(`RemoteAuth session uploaded: ${fileName}`);
              resolve(true);
            }
          } catch (e) {
            console.error('Upload failed:', e);
            resolve(false);
          } finally {
            await fs.remove(tempPath).catch(() => {});
            await fs.remove(zipPath).catch(() => {});
          }
        });

        archive.on('error', (err) => {
          console.error('Archive error:', err);
          resolve(false);
        });

        archive.pipe(output);
        archive.glob('**/*', { cwd: tempPath, dot: true });
        archive.finalize();
      });
    } catch (e) {
      console.error('RemoteAuth session sync error:', e);
      return false;
    }
  }

  async uploadInChunks(zipBuffer) {
    try {
      const CHUNK_SIZE = 10 * 1024 * 1024;
      const totalChunks = Math.ceil(zipBuffer.length / CHUNK_SIZE);
      const sessionId = `remoteauth-admin-${Date.now()}`;
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
      await this.store.save({
        session: 'admin',
        data: {
          session_chunks: chunkPaths,
          is_chunked: true,
          total_chunks: totalChunks,
          last_sync: new Date().toISOString(),
          is_remoteauth: true,
          sync_version: '3.0'
        }
      });
      console.log('All chunks uploaded successfully');
      return true;
    } catch (error) {
      console.error('Chunk upload failed:', error);
      return false;
    }
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
      if (chunks.length === 0) return null;
      return Buffer.concat(chunks);
    } catch (error) {
      console.error('Chunk assembly failed:', error);
      return null;
    }
  }

  // -------------------------
  // Restore from Supabase (HYBRID mode)
  // -------------------------
  async restoreSessionFromSupabase() {
    if (this.isRestoring) {
      console.log('Restore already in progress');
      return false;
    }
    this.isRestoring = true;
    try {
      console.log('Restoring RemoteAuth session from Supabase...');
      const sessionData = await this.store.extract('admin');
      if (!sessionData) {
        console.log('No session data found in Supabase');
        return false;
      }

      const sessionPath = path.join(this.authPath, 'RemoteAuth-admin');

      // Clear existing session directory first (safe)
      if (fs.existsSync(sessionPath)) {
        try {
          await fs.remove(sessionPath);
          console.log('Cleared existing RemoteAuth session directory');
        } catch (e) {
          console.warn('Could not fully clear existing session directory:', e);
        }
      }
      this.ensureDirectoryExists(sessionPath);

      let zipBuffer = null;

      if (sessionData.is_chunked && Array.isArray(sessionData.session_chunks) && sessionData.session_chunks.length) {
        console.log('Reassembling from chunks...');
        zipBuffer = await this.downloadAndAssembleChunks(sessionData.session_chunks);
      } else if (sessionData.session_zip_path) {
        const { data, error } = await this.store.supabase.storage
          .from('whatsapp-sessions')
          .download(sessionData.session_zip_path);
        if (error) throw error;
        zipBuffer = Buffer.from(await data.arrayBuffer());
      } else {
        console.log('No valid session path found in Supabase metadata');
        return false;
      }

      if (!zipBuffer || zipBuffer.length === 0) {
        console.log('Empty zip buffer received');
        return false;
      }

      const zipPath = path.join(this.authPath, 'restore-remoteauth.zip');
      await fs.writeFile(zipPath, zipBuffer);

      // Extract
      const AdmZip = (await import('adm-zip')).default;
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(sessionPath, true);
      await fs.remove(zipPath);

      // Wait for the written files to stabilize
      console.log('Waiting for session files to stabilize...');
      const hydrated = await this.waitForSessionHydration(this.sessionRestoreTimeoutMs, this.restorePollIntervalMs);
      if (!hydrated) {
        console.warn('Session hydration timed out or files not stable after extraction');
        // Partial restore may have happened; still continue but treat as not fully restored
        this.isHydrated = false;
        return false;
      }

      console.log('RemoteAuth session restored and verified successfully');
      this.isHydrated = true;
      return true;
    } catch (e) {
      console.error('RemoteAuth session restore failed:', e);
      return false;
    } finally {
      this.isRestoring = false;
    }
  }

  // -------------------------
  // Initialization (Hybrid flow)
  // -------------------------
  async initializeBot() {
    if (this.isInitializing) {
      console.log('Bot is already initializing...');
      return;
    }

    this.isInitializing = true;
    try {
      console.log('Initializing bot with RemoteAuth and manual Supabase sync...');

      const hasLocal = this.hasLocalSession();
      console.log(`Local RemoteAuth session check: ${hasLocal}`);

      // If force QR requested, ignore restore and force QR
      if (this.forceQR) {
        console.log('Force QR mode - skipping session restoration');
        this.forceQR = false;
      } else if (!hasLocal) {
        console.log('No local session found -> attempting restore from Supabase (hybrid mode)');
        const restored = await this.restoreSessionFromSupabase();
        if (restored) {
          console.log('Restore succeeded. Proceeding to initialize client using restored session.');
        } else {
          console.log('Restore failed or incomplete. Will allow QR fallback if needed.');
        }
      } else {
        console.log('Using existing local RemoteAuth session (no restore attempted)');
      }

      // At this point: either we have a hydrated local session or we will start client and let RemoteAuth decide
      // We make sure not to initialize while isRestoring is true
      if (this.isRestoring) {
        console.log('Still restoring session; delaying initialization until restore completes');
        // Wait up to sessionRestoreTimeoutMs for restore to complete (defensive)
        const deadline = Date.now() + this.sessionRestoreTimeoutMs;
        while (this.isRestoring && Date.now() < deadline) {
          await wait(500);
        }
      }

      // If we were able to hydrate local session, ensure isHydrated true; otherwise keep fallback behavior
      const authStrategy = new RemoteAuth({
        clientId: 'admin',
        dataPath: this.authPath,
        store: this.store,
        backupSyncIntervalMs: 5 * 60 * 1000,
      });

      // Create client
      this.client = new Client({
        authStrategy,
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
            '--disable-features=VizDisplayCompositor',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-ipc-flooding-protection',
            '--no-default-browser-check',
            '--disable-default-apps',
            '--disable-translate',
            '--disable-extensions',
            '--disable-component-extensions-with-background-pages',
            '--disable-component-update',
            '--disable-back-forward-cache',
            '--disable-session-crashed-bubble',
            '--disable-crash-reporter',
            '--disable-plugins',
            '--disable-plugins-discovery',
            '--disable-pdf-tagging',
            '--disable-partial-raster',
            '--disable-skia-runtime-opts',
            '--disable-logging',
            '--disable-in-process-stack-traces',
            '--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process',
            '--use-gl=swiftshader',
            '--enable-features=NetworkService,NetworkServiceInProcess',
            '--aggressive-cache-discard',
            '--max_old_space_size=512',
            '--password-store=basic',
            '--use-mock-keychain',
          ],
          ignoreDefaultArgs: [
            '--disable-extensions',
            '--enable-automation'
          ],
          timeout: 60000,
          protocolTimeout: 60000,
        },
        takeoverOnConflict: false,
        takeoverTimeoutMs: 0,
        restartOnAuthFail: false,
        qrMaxRetries: 2,
      });

      // Setup event handlers and initialize
      this.setupClientEvents();
      await this.client.initialize();
    } catch (error) {
      console.error('Error initializing bot:', error);
      try {
        this.emitToAllSockets('bot-error', { error: error?.message || String(error) });
      } catch (e) {
        // swallow
      }
    } finally {
      this.isInitializing = false;
      this.isWaitingForSession = false;
    }
  }

  // -------------------------
  // Client events
  // -------------------------
  setupClientEvents() {
    if (!this.client) return;

    let qrGenerated = false;

    this.client.on('qr', async (qr) => {
      try {
        console.log('QR code generated - scanning required');
        qrGenerated = true;
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
      if (this.hasLocalSession() && percent > 0 && !qrGenerated) {
        this.emitToAllSockets('bot-status', { status: 'authenticating_with_session' });
      }
    });

    this.client.on('authenticated', () => {
      console.log('Bot authenticated with RemoteAuth');
      this.emitToAllSockets('bot-status', { status: 'authenticated' });
      this.forceQR = false;
    });

    this.client.on('ready', async () => {
      try {
        console.log('Bot connected successfully with RemoteAuth');
        this.emitToAllSockets('bot-status', { status: 'connected' });
        this.isInitializing = false;
        this.isWaitingForSession = false;
        this.sessionRetryAttempts = 0;
        this.forceQR = false;
        this.currentQrCode = null;

        // Sync session to Supabase after a short delay to allow WA to settle writes
        setTimeout(async () => {
          try {
            const syncSuccess = await this.syncSessionToSupabase();
            if (syncSuccess) {
              console.log('RemoteAuth session successfully synced to Supabase');
            }
          } catch (syncError) {
            console.error('RemoteAuth session sync error:', syncError);
          }
        }, 10000);
      } catch (e) {
        console.error('Error during ready handler:', e);
      }
    });

    this.client.on('remote_session_saved', () => {
      console.log('RemoteAuth: Session saved to remote store');
      // trigger manual sync for redundancy
      setTimeout(async () => {
        try {
          await this.syncSessionToSupabase();
        } catch (error) {
          console.error('Manual sync after remote save failed:', error);
        }
      }, 5000);
    });

    this.client.on('auth_failure', (error) => {
      console.error('Bot auth failed:', error);
      this.emitToAllSockets('bot-error', { error: 'Authentication failed' });
      this.isInitializing = false;
      // Let RemoteAuth decide next steps - we don't forcibly reinit here
    });

    this.client.on('disconnected', async (reason) => {
      try {
        console.log('Bot disconnected:', reason);
        this.emitToAllSockets('bot-status', { status: 'disconnected' });
        // destroy client reference to avoid double-inits
        if (this.client) {
          try { await this.client.destroy(); } catch (e) {}
          this.client = null;
        }
        this.isProcessing = false;
        this.groupsCache = { data: [], lastUpdated: 0, cacheDuration: 5 * 60 * 1000, isUpdating: false };
        this.processingQueue = [];
        this.currentProcessingRequest = null;
        this.groupCaches.clear();

        // Attempt to restore and reinitialize after a small delay
        setTimeout(async () => {
          console.log('Attempting to restore RemoteAuth session from Supabase after disconnect...');
          const hasLocal = this.hasLocalSession();
          if (!hasLocal) {
            const restored = await this.restoreSessionFromSupabase();
            if (restored) {
              console.log('RemoteAuth session restored from Supabase, reinitializing...');
            } else {
              console.log('No valid session available in Supabase after disconnect');
            }
          }
          // Reinitialize (hybrid will decide QR fallback)
          this.initializeBot();
        }, 5000);
      } catch (e) {
        console.error('Error in disconnected handler:', e);
      }
    });

    this.client.on('message', async (message) => {
      try {
        await this.handleMessage(message);
      } catch (e) {
        console.error('Error handling message event:', e);
      }
    });
  }

  // -------------------------
  // Stop, clear, force QR
  // -------------------------
  stopBot() {
    try {
      console.log('Stopping bot and cleaning up memory...');
      if (this.client) {
        try { this.client.destroy(); } catch (e) {}
        this.client = null;
      }
      this.isInitializing = false;
      this.processingQueue = [];
      this.isProcessing = false;
      this.currentProcessingRequest = null;
      this.groupCaches.clear();
      console.log('Bot stopped and memory cleaned up');
    } catch (e) {
      console.error('Error in stopBot:', e);
    }
  }

  setActiveGroups(groups) {
    this.activeGroups = groups;
    this.saveActiveGroupsToDisk();
    this.emitToAllSockets('active-groups-updated', { groups });
    console.log('Set active groups:', groups);
  }

  // -------------------------
  // Message handling helpers
  // -------------------------
  async handleMessage(message) {
    try {
      if (this.activeGroups.length === 0) return;
      const chat = await message.getChat();
      if (!chat.isGroup) return;
      if (!this.activeGroups.includes(chat.id._serialized)) return;
      const messageTimestamp = message.timestamp;
      const twoMinutesAgo = Date.now() / 1000 - 120;
      if (messageTimestamp < twoMinutesAgo) return;
      const messageText = message.body || '';
      if (this.isBotCommand(messageText)) {
        const isSearchCommand = messageText.toLowerCase().includes('!ai_search');
        const prompt = this.extractPrompt(message.body, isSearchCommand);
        if (!prompt) return;
        await this.addToQueue(message, chat, prompt, isSearchCommand);
      }
    } catch (e) {
      console.error('Error in handleMessage:', e);
    }
  }

  isBotCommand(messageText) {
    if (!messageText) return false;
    const commands = ['!bot', '!ai', '@bot', 'bot,', '!ai_search'];
    return commands.some(cmd => messageText.toLowerCase().includes(cmd));
  }

  // -------------------------
  // API helpers
  // -------------------------
  async callExternalAPI(payload) {
    const apiUrl = process.env.API_ENDPOINT;
    const generateEndpoint = `${apiUrl}/generate_real_time`;
    console.log(`[API] Calling: ${generateEndpoint}`);
    console.log(`[API] Sending ${payload.messages.length} messages`);
    try {
      const response = await axios.post(generateEndpoint, {
        messages: payload.messages,
        prompt: payload.prompt,
        group_name: payload.groupName,
        cache_info: {
          total_messages: payload.totalMessageCount,
          new_messages: payload.newMessageCount,
          has_cached_context: payload.totalMessageCount > payload.newMessageCount
        }
      }, {
        timeout: 10 * 60 * 1000,
        headers: { 'Content-Type': 'application/json' },
      });
      const data = response.data || {};
      return data.response || data.answer || data.text || 'I received your message but cannot generate a response right now.';
    } catch (error) {
      console.error('API call failed:', error?.message || error);
      return 'Sorry, there was an error processing your request. Please try again later.';
    }
  }

  async callExternalAPISearch(payload) {
    const apiUrl = process.env.API_ENDPOINT;
    const generateEndpoint = `${apiUrl}/generate_realtime_search`;
    console.log(`[API-SEARCH] Calling: ${generateEndpoint}`);
    try {
      const response = await axios.post(generateEndpoint, {
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
      }, {
        timeout: 10 * 60 * 1000,
        headers: { 'Content-Type': 'application/json' },
      });
      const data = response.data || {};
      let responseText = data.response || data.answer || data.text || 'I received your message but cannot generate a response right now.';
      if (data.search_info && data.search_info.search_query) {
        responseText += `\n\n*Search Info:* Queried "${data.search_info.search_query}"`;
        if (data.search_info.articles_found) {
          responseText += `, found ${data.search_info.articles_found} articles`;
        }
      }
      return responseText;
    } catch (error) {
      console.error('Search API call failed:', error?.message || error);
      return 'Sorry, the search request failed. Please try again later or use !ai for a faster response.';
    }
  }

  extractPrompt(messageText = '', isSearchCommand = false) {
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

  // -------------------------
  // Persistent active groups
  // -------------------------
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

  // -------------------------
  // Clearing sessions / force QR
  // -------------------------
  async clearSupabaseSession() {
    try {
      const sessionPath = path.join(this.authPath, 'RemoteAuth-admin');
      if (fs.existsSync(sessionPath)) {
        await fs.remove(sessionPath);
        console.log('Local RemoteAuth session cleared');
      }
      // Note: SupabaseSessionStorage.delete expects a string session id
      await this.store.delete('admin');
      console.log('Supabase session cleared');
    } catch (error) {
      console.error('Error clearing sessions:', error);
    }
  }

  async forceQRGeneration() {
    try {
      console.log('Force QR generation requested...');
      this.forceQR = true;
      await this.clearSupabaseSession();
      if (this.client) {
        try { await this.client.destroy(); } catch (e) {}
        this.client = null;
      }
      this.isInitializing = false;
      this.isWaitingForSession = false;
      setTimeout(() => this.initializeBot(), 2000);
      return true;
    } catch (e) {
      console.error('Error in forceQRGeneration:', e);
      return false;
    }
  }

  async backupSession() {
    try {
      console.log('Manual RemoteAuth session backup requested...');
      const success = await this.syncSessionToSupabase();
      return {
        success,
        message: success ? 'RemoteAuth session successfully backed up to Supabase' : 'Session backup failed'
      };
    } catch (error) {
      console.error('Manual backup failed:', error);
      return { success: false, message: 'Backup failed: ' + error.message };
    }
  }

  async restoreSession() {
    try {
      console.log('Manual RemoteAuth session restore requested...');
      const success = await this.restoreSessionFromSupabase();
      return {
        success,
        message: success ? 'RemoteAuth session restored from Supabase. Please restart the bot.' : 'Session restore failed - no valid session in Supabase'
      };
    } catch (error) {
      console.error('Manual restore failed:', error);
      return { success: false, message: 'Restore failed: ' + error.message };
    }
  }

  // -------------------------
  // Socket helpers
  // -------------------------
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

  // -------------------------
  // Status helpers
  // -------------------------
  getBotStatus() {
    if (this.client && this.client.info) return 'connected';
    if (this.hasLocalSession()) return 'session_exists';
    return 'disconnected';
  }
}

export default BotManager;
