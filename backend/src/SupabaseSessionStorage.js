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

  async saveZipBackup(session, data) {
    try {
      const zipPath = this.getZipPath(session);
      // For now, we'll just create an empty file to satisfy RemoteAuth
      await fs.writeFile(zipPath, JSON.stringify({
        session,
        data,
        _backup: true,
        timestamp: new Date().toISOString()
      }));
      console.log(`✅ Created ZIP backup for session: ${session}`);
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
      
      const data = await fs.readFile(zipPath, 'utf8');
      const parsed = JSON.parse(data);
      console.log(`✅ Loaded ZIP backup for session: ${session}`);
      return parsed.data;
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
      
      // First check if ZIP backup exists (RemoteAuth prefers this)
      const zipPath = this.getZipPath(session);
      if (fs.existsSync(zipPath)) {
        console.log('✅ sessionExists -> found ZIP backup');
        return true;
      }
      
      // Fall back to Supabase check
      const { data, error } = await this.supabase
        .from(this.table)
        .select('session_data')
        .eq('session_id', session)
        .maybeSingle();

      if (error) {
        console.error('❌ Supabase sessionExists error:', error);
        return false;
      }
      if (!data || !data.session_data) {
        console.log('❌ sessionExists -> not found or empty');
        return false;
      }
      console.log('✅ sessionExists -> found in Supabase');
      return true;
    } catch (err) {
      console.error('❌ sessionExists exception:', err);
      return false;
    }
  }

  async extract({ session }) {
    try {
      console.log(`🔍 extract called for session=${session}`);
      
      // Try to load from ZIP backup first
      const zipData = await this.loadZipBackup(session);
      if (zipData) {
        console.log(`✅ extract -> found data in ZIP backup, type: ${typeof zipData}`);
        return zipData;
      }
      
      // Fall back to Supabase
      const { data, error } = await this.supabase
        .from(this.table)
        .select('session_data')
        .eq('session_id', session)
        .maybeSingle();

      if (error) {
        console.error('❌ Supabase extract error:', error);
        return null;
      }
      if (!data) {
        console.log('❌ extract -> no data found');
        return null;
      }
      
      const sessionData = data.session_data;
      console.log(`✅ extract -> found data in Supabase, type: ${typeof sessionData}`);
      
      // Create ZIP backup for next time
      await this.saveZipBackup(session, sessionData);
      
      return sessionData || null;
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

      // Save to ZIP backup (RemoteAuth expects this)
      await this.saveZipBackup(session, data);
      
      // Also save to Supabase for persistence
      if (typeof data === 'object' && Object.keys(data).length === 0) {
        console.log('⚠️ Empty object data, but saving anyway for debugging...');
        const debugData = {
          _debug: 'empty_object_saved',
          timestamp: new Date().toISOString(),
          original_data: data
        };
        await this._upsertRow(session, debugData);
        console.log(`✅ Saved debug data for session: ${session}`);
        return;
      }

      console.log(`💽 Data to save:`, {
        type: typeof data,
        isBuffer: Buffer.isBuffer(data),
        isObject: typeof data === 'object',
        keys: typeof data === 'object' ? Object.keys(data) : 'N/A',
        sample: typeof data === 'object' ? JSON.stringify(data).substring(0, 200) : String(data).substring(0, 200)
      });

      await this._upsertRow(session, data);
      console.log(`✅ Supabase: session saved: ${session}`);
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