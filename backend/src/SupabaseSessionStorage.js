// backend/src/SupabaseSessionStorage.js
import { createClient } from '@supabase/supabase-js';

class SupabaseSessionStorage {
  constructor(opts = {}) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!url || !key) {
      console.warn('Supabase: Missing SUPABASE_URL or key. RemoteAuth will not persist.');
    }

    this.supabase = createClient(url, key);
    this.table = opts.table || 'whatsapp_sessions';
    
    console.log('🔧 SupabaseSessionStorage initialized with table:', this.table);
  }

  // -------------------------------
  // HELPERS
  // -------------------------------
  _normalizeArgsForSave(...args) {
    console.log('🔄 _normalizeArgsForSave called with args:', args);
    
    // Accept: save({ session, data })
    // Or:    save(session, data)
    // Or:    save(data) (where data includes a client id)
    if (args.length === 1 && typeof args[0] === 'object') {
      const obj = args[0];
      const session = obj.session || obj.session_id || obj.clientId || 'RemoteAuth-admin';
      const data = obj.data || obj.session_data || obj;
      console.log(`🔄 Normalized: session=${session}, dataType=${typeof data}, dataKeys=${data && typeof data === 'object' ? Object.keys(data) : 'N/A'}`);
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

  // sessionExists({ session })
  async sessionExists({ session }) {
    try {
      console.log(`🔍 sessionExists called with session=${session}`);
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
      console.log('✅ sessionExists -> true');
      return true;
    } catch (err) {
      console.error('❌ sessionExists exception:', err);
      return false;
    }
  }

  // extract({ session }) — your existing name
  async extract({ session }) {
    try {
      console.log(`🔍 extract called for session=${session}`);
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
      console.log(`✅ extract -> found data type: ${typeof sessionData}`);
      
      return sessionData || null;
    } catch (err) {
      console.error('❌ extract exception:', err);
      return null;
    }
  }

  // restore() — compatibility alias used by some versions
  async restore(session) {
    // RemoteAuth sometimes calls store.restore(session) or store.restore()
    const id = session && typeof session === 'string' ? session : (session && session.session) || 'RemoteAuth-admin';
    console.log(`🔄 restore called, resolving id=${id}`);
    return await this.extract({ session: id });
  }

  // save(...) flexible wrapper
  async save(...args) {
    try {
      console.log(`💾 save called with ${args.length} arguments:`, args);
      
      const { session, data } = this._normalizeArgsForSave(...args);
      console.log(`💾 Normalized save: session=${session}, dataPresent=${!!data}, dataType=${typeof data}`);

      if (!data) {
        console.log('⚠️ No data to save (data is null/undefined).');
        return;
      }

      if (typeof data === 'object' && Object.keys(data).length === 0) {
        console.log('⚠️ Empty object data, but saving anyway for debugging...');
        // Save empty object with debug info
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

  // delete({ session })
  async delete({ session }) {
    try {
      console.log(`🗑️ delete called for session=${session}`);
      const { error } = await this.supabase
        .from(this.table)
        .delete()
        .eq('session_id', session);

      if (error) {
        console.error('❌ Supabase delete error:', error);
        throw error;
      }
      console.log('✅ delete successful');
    } catch (err) {
      console.error('❌ delete exception:', err);
    }
  }

  // Provide aliases that some RemoteAuth versions may call
  async remove(sessionOrObj) {
    // alias
    console.log(`🗑️ remove called with:`, sessionOrObj);
    if (typeof sessionOrObj === 'object') {
      return this.delete(sessionOrObj);
    }
    return this.delete({ session: sessionOrObj });
  }

  // RemoteAuth store interface methods
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