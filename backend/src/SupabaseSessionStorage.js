// backend/src/SupabaseSessionStorage.js

import { createClient } from '@supabase/supabase-js';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class SupabaseSessionStorage {
  constructor(opts = {}) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!url || !key) {
      console.warn('Supabase: Missing SUPABASE_URL or key. RemoteAuth will not persist.');
    }

    this.supabase = createClient(url, key);
    this.table = opts.table || 'whatsapp_sessions';
    
    // Add local backup path for ZIP files
    this.authPath = process.env.NODE_ENV === 'production' 
      ? path.join(process.cwd(), 'auth')
      : path.join(__dirname, '../auth');
    
    this.ensureDirectoryExists(this.authPath);
    
    console.log('🔧 SupabaseSessionStorage initialized with table:', this.table);
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

  // -------------------------------
  // ZIP FILE MANAGEMENT (for RemoteAuth compatibility)
  // -------------------------------

  getZipPath(session) {
    return path.join(this.authPath, `${session}.zip`);
  }

  // Only create ZIP backup when we have actual session data
  async saveZipBackup(session, data) {
    try {
      // Don't create empty backups - this prevents RemoteAuth from using invalid sessions
      if (!data || (typeof data === 'object' && Object.keys(data).length === 0)) {
        console.log(`⚠️ Skipping ZIP backup - no valid session data for: ${session}`);
        return false;
      }

      const zipPath = this.getZipPath(session);
      
      // Create a minimal valid session structure that RemoteAuth expects
      const backupData = {
        session,
        data: data,
        _backup: true,
        timestamp: new Date().toISOString()
      };
      
      await fs.writeFile(zipPath, JSON.stringify(backupData));
      console.log(`✅ Created valid ZIP backup for session: ${session}`);
      return true;
    } catch (error) {
      console.error(`❌ Failed to create ZIP backup for ${session}:`, error);
      return false;
    }
  }

  async loadZipBackup(session) {
    try {
      const zipPath = this.getZipPath(session);
      if (!fs.existsSync(zipPath)) {
        console.log(`❌ ZIP backup not found for session: ${session}`);
        return null;
      }
      
      const fileData = await fs.readFile(zipPath, 'utf8');
      const parsed = JSON.parse(fileData);
      
      // Only return if we have valid session data
      if (parsed.data && typeof parsed.data === 'object' && Object.keys(parsed.data).length > 0) {
        console.log(`✅ Loaded valid ZIP backup for session: ${session}`);
        return parsed.data;
      } else {
        console.log(`⚠️ ZIP backup exists but contains no valid session data for: ${session}`);
        return null;
      }
    } catch (error) {
      console.error(`❌ Failed to load ZIP backup for ${session}:`, error);
      return null;
    }
  }

  async deleteZipBackup(session) {
    try {
      const zipPath = this.getZipPath(session);
      if (fs.existsSync(zipPath)) {
        await fs.remove(zipPath);
        console.log(`✅ Deleted ZIP backup for session: ${session}`);
      }
      return true;
    } catch (error) {
      console.error(`❌ Failed to delete ZIP backup for ${session}:`, error);
      return false;
    }
  }

  // -------------------------------
  // HELPERS
  // -------------------------------

  _normalizeArgsForSave(...args) {
    console.log('🔄 _normalizeArgsForSave called with args:', args);
    
    if (args.length === 1 && typeof args[0] === 'object') {
      const obj = args[0];
      const session = obj.session || obj.session_id || obj.clientId || 'RemoteAuth-admin';
      const data = obj.data || obj.session_data || obj;
      console.log(`🔄 Normalized: session=${session}, dataType=${typeof data}`);
      return { session, data };
    }
    if (args.length === 2) {
      console.log(`🔄 Normalized: session=${args[0]}, dataType=${typeof args[1]}`);
      return { session: args[0], data: args[1] };
    }
    console.log('🔄 Normalized: using default session=RemoteAuth-admin');
    return { session: 'RemoteAuth-admin', data: null };
  }

  async _upsertRow(sessionId, sessionData) {
    try {
      console.log(`📦 _upsertRow: sessionId=${sessionId}, dataType=${typeof sessionData}`);
      
      const payload = {
        session_id: sessionId,
        session_data: sessionData,
        updated_at: new Date().toISOString()
      };

      console.log('📦 Upserting payload to Supabase...');
      const { error } = await this.supabase
        .from(this.table)
        .upsert(payload, { onConflict: 'session_id' });

      if (error) {
        console.error('❌ Supabase upsert error:', error);
        throw error;
      }
      console.log('✅ _upsertRow successful');
      return true;
    } catch (err) {
      console.error('❌ Supabase _upsertRow failed:', err.message || err);
      throw err;
    }
  }

  // -------------------------------
  // REQUIRED STORE INTERFACE METHODS
  // -------------------------------

  async sessionExists({ session }) {
    try {
      console.log(`🔍 sessionExists called with session=${session}`);
      
      // First check Supabase for valid session
      const { data, error } = await this.supabase
        .from(this.table)
        .select('session_data')
        .eq('session_id', session)
        .maybeSingle();

      if (error) {
        console.error('❌ Supabase sessionExists error:', error);
        // Fall back to ZIP check
        return await this.checkZipBackupExists(session);
      }
      
      if (data && data.session_data) {
        console.log('✅ sessionExists -> found valid session in Supabase');
        return true;
      }

      // Fall back to ZIP backup check
      return await this.checkZipBackupExists(session);
      
    } catch (err) {
      console.error('❌ sessionExists exception:', err);
      return false;
    }
  }

  async checkZipBackupExists(session) {
    try {
      const zipPath = this.getZipPath(session);
      if (!fs.existsSync(zipPath)) {
        return false;
      }
      
      // Check if ZIP backup has valid data
      const zipData = await this.loadZipBackup(session);
      const exists = zipData !== null;
      console.log(`✅ sessionExists -> ZIP backup ${exists ? 'exists with valid data' : 'exists but invalid'}`);
      return exists;
    } catch (error) {
      console.error('Error checking ZIP backup:', error);
      return false;
    }
  }

  async extract({ session }) {
    try {
      console.log(`🔍 extract called for session=${session}`);
      
      // Try to load from Supabase first
      const { data, error } = await this.supabase
        .from(this.table)
        .select('session_data')
        .eq('session_id', session)
        .maybeSingle();

      if (!error && data && data.session_data) {
        const sessionData = data.session_data;
        console.log(`✅ extract -> found valid data in Supabase, type: ${typeof sessionData}`);
        
        // Create ZIP backup for next time (only if we have valid data)
        await this.saveZipBackup(session, sessionData);
        
        return sessionData;
      }

      // Fall back to ZIP backup
      console.log('⚠️ No valid Supabase session, falling back to ZIP backup...');
      const zipData = await this.loadZipBackup(session);
      if (zipData) {
        console.log(`✅ extract -> found valid data in ZIP backup, type: ${typeof zipData}`);
        return zipData;
      }

      console.log('❌ extract -> no valid session data found anywhere');
      return null;
      
    } catch (err) {
      console.error('❌ extract exception:', err);
      return null;
    }
  }

  async restore(session) {
    const id = session && typeof session === 'string' ? session : (session && session.session) || 'RemoteAuth-admin';
    console.log(`🔄 restore called, resolving id=${id}`);
    return await this.extract({ session: id });
  }

  async save(...args) {
    try {
      console.log(`💾 save called with ${args.length} arguments:`, args);
      
      const { session, data } = this._normalizeArgsForSave(...args);
      console.log(`💾 Normalized save: session=${session}, dataPresent=${!!data}, dataType=${typeof data}`);

      if (!data) {
        console.log('⚠️ No data to save (data is null/undefined).');
        return;
      }

      // Only save to Supabase if we have valid data
      if (typeof data === 'object' && Object.keys(data).length === 0) {
        console.log('⚠️ Empty object data detected - this might be an initial empty session');
        // Don't save empty sessions to avoid issues
        return;
      }

      console.log(`💽 Data to save:`, {
        type: typeof data,
        isBuffer: Buffer.isBuffer(data),
        isObject: typeof data === 'object',
        keys: typeof data === 'object' ? Object.keys(data) : 'N/A'
      });

      // Save to Supabase
      await this._upsertRow(session, data);
      
      // Only create ZIP backup if we have substantial session data
      if (typeof data === 'object' && Object.keys(data).length > 2) {
        await this.saveZipBackup(session, data);
      }
      
      console.log(`✅ Session saved successfully: ${session}`);
      return;
    } catch (err) {
      console.error('❌ Error in save():', err);
      throw err;
    }
  }

  async delete({ session }) {
    try {
      console.log(`🗑️ delete called for session=${session}`);
      
      // Delete from both ZIP backup and Supabase
      await this.deleteZipBackup(session);
      
      const { error } = await this.supabase
        .from(this.table)
        .delete()
        .eq('session_id', session);

      if (error) {
        console.error('❌ Supabase delete error:', error);
        throw error;
      }
      console.log('✅ delete successful - removed from both ZIP and Supabase');
    } catch (err) {
      console.error('❌ delete exception:', err);
    }
  }

  async remove(sessionOrObj) {
    console.log(`🗑️ remove called with:`, sessionOrObj);
    if (typeof sessionOrObj === 'object') {
      return this.delete(sessionOrObj);
    }
    return this.delete({ session: sessionOrObj });
  }

  async get(sessionId) {
    console.log(`🔍 get called for sessionId=${sessionId}`);
    return await this.extract({ session: sessionId });
  }

  async set(sessionId, data) {
    console.log(`💾 set called for sessionId=${sessionId}`);
    return await this.save(sessionId, data);
  }
}

export default SupabaseSessionStorage;