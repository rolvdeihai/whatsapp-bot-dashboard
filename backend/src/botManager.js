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
    
    // 🆕 GLOBAL Request queue system - one queue for all groups
    this.processingQueue = []; // Array of pending requests from all groups
    this.isProcessing = false; // Global processing flag
    this.currentProcessingRequest = null; // Track currently processing request
    
    this.loadActiveGroupsFromDisk();
    
    // Create cache directory if it doesn't exist
    this.cacheDir = path.join(__dirname, '../group_cache');
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
    
    // Auto-initialize bot when server starts
    this.initializeBot();
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
    const dataPath = path.join(__dirname, '../auth', 'activeGroups.json');
    fs.writeFileSync(dataPath, JSON.stringify(this.activeGroups));
    console.log('Active groups saved to disk.');
  }

  // Load the activeGroups array from a JSON file
  loadActiveGroupsFromDisk() {
    const dataPath = path.join(__dirname, '../auth', 'activeGroups.json');
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

  // Helper method to check if session files exist
  hasSession() {
    const sessionPath = path.join(__dirname, '../auth', 'session-admin');
    try {
      if (fs.existsSync(sessionPath)) {
        const files = fs.readdirSync(sessionPath);
        const hasSessionFiles = files.some(file => 
          file.includes('session') || 
          file.endsWith('.json') || 
          file === 'wwebjs.browserid' ||
          file === 'wwebjs.session.json'
        );
        console.log(`Session check: ${hasSessionFiles} (found files: ${files})`);
        return hasSessionFiles;
      }
      return false;
    } catch (error) {
      console.error('Error checking session:', error);
      return false;
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

  async initializeBot() {
    if (this.isInitializing) {
      console.log('Bot is already initializing...');
      return;
    }

    this.isInitializing = true;
    
    try {
      if (this.hasSession()) {
        console.log('Found persistent session, attempting to restore');
        this.client = new Client({
          authStrategy: new LocalAuth({ 
            clientId: 'admin',
            dataPath: '/app/auth' // Use absolute path to mounted disk
          }),
          puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
          }
        });

        this.setupClientEvents();
        await this.client.initialize();
      } else {
        console.log('No existing session found, requiring QR scan');
        this.client = new Client({
          authStrategy: new LocalAuth({ 
            clientId: 'admin',
            dataPath: path.join(__dirname, '../auth')
          }),
          puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
          }
        });

        this.setupClientEvents();
        await this.client.initialize();
      }
    } catch (error) {
      console.error('Error initializing bot:', error);
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
        console.log('QR code generated and sent to frontend');
      } catch (error) {
        console.error('Error generating QR code:', error);
        this.emitToAllSockets('bot-error', { error: 'Failed to generate QR code' });
      }
    });

    this.client.on('ready', () => {
      console.log('Bot connected successfully');
      this.emitToAllSockets('bot-status', { status: 'connected' });
      this.isInitializing = false;
    });

    this.client.on('authenticated', () => {
      console.log('Bot authenticated');
      this.emitToAllSockets('bot-status', { status: 'authenticated' });
    });

    this.client.on('auth_failure', (error) => {
      console.error('Bot auth failed:', error);
      this.emitToAllSockets('bot-error', { error: 'Authentication failed' });
      this.isInitializing = false;
    });

    this.client.on('disconnected', (reason) => {
      console.log('Bot disconnected:', reason);
      this.emitToAllSockets('bot-status', { status: 'disconnected' });
      this.client = null;
      this.isProcessing = false;
      
      // 🆕 Clear global queue on disconnect
      this.processingQueue = [];
      this.currentProcessingRequest = null;
      
      setTimeout(() => {
        this.initializeBot();
      }, 5000);
    });

    this.client.on('message', async (message) => {
      await this.handleMessage(message);
    });
  }

  stopBot() {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    this.isInitializing = false;
    
    // 🆕 Clear global queue on stop
    this.processingQueue = [];
    this.isProcessing = false;
    this.currentProcessingRequest = null;
  }

  async getGroups() {
    try {
      if (!this.client || !this.client.info) {
        return [];
      }

      const chats = await this.client.getChats();
      const groups = chats.filter(chat => chat.isGroup);
      
      return groups.map(group => ({
        id: group.id._serialized,
        name: group.name,
        participants: group.participants.length
      }));
    } catch (error) {
      console.error('Error fetching groups:', error);
      return [];
    }
  }

  setActiveGroups(groups) {
    this.activeGroups = groups;
    this.saveActiveGroupsToDisk();
    this.emitToAllSockets('active-groups-updated', { groups: groups });
    console.log('Set active groups:', groups);
  }

  getBotStatus() {
    if (this.client && this.client.info) return 'connected';
    if (this.hasSession()) return 'session_exists';
    return 'disconnected';
  }

  async handleMessage(message) {
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
}

export default BotManager;