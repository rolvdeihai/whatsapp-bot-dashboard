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
  }

  // -------------------------------
  // HELPERS
  // -------------------------------
  _normalizeArgsForSave(...args) {
    // Accept: save({ session, data })
    // Or:    save(session, data)
    // Or:    save(data) (where data includes a client id)
    if (args.length === 1 && typeof args[0] === 'object') {
      const obj = args[0];
      return { session: obj.session || obj.session_id || obj.clientId || 'admin', data: obj.data || obj.session_data || obj };
    }
    if (args.length === 2) {
      return { session: args[0], data: args[1] };
    }
    return { session: 'admin', data: null };
  }

  async _upsertRow(sessionId, sessionData) {
    try {
      const payload = {
        session_id: sessionId,
        session_data: sessionData,
        updated_at: new Date().toISOString()
      };

      const { error } = await this.supabase
        .from(this.table)
        .upsert(payload, { onConflict: 'session_id' });

      if (error) {
        console.error('Supabase upsert error:', error);
        throw error;
      }
      return true;
    } catch (err) {
      console.error('Supabase _upsertRow failed:', err.message || err);
      throw err;
    }
  }

  // -------------------------------
  // REQUIRED STORE INTERFACE METHODS
  // We provide multiple method names (aliases) to maximize compatibility.
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
        console.error('Supabase sessionExists error:', error);
        return false;
      }
      if (!data || !data.session_data) {
        console.log('sessionExists -> not found or empty');
        return false;
      }
      console.log('sessionExists -> true');
      return true;
    } catch (err) {
      console.error('sessionExists exception:', err);
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
        console.error('Supabase extract error:', error);
        return null;
      }
      if (!data) return null;
      return data.session_data || null;
    } catch (err) {
      console.error('extract exception:', err);
      return null;
    }
  }

  // restore() — compatibility alias used by some versions
  async restore(session) {
    // RemoteAuth sometimes calls store.restore(session) or store.restore()
    const id = session && typeof session === 'string' ? session : (session && session.session) || 'admin';
    console.log('restore called, resolving id=', id);
    return await this.extract({ session: id });
  }

  // save(...) flexible wrapper
  async save(...args) {
    try {
      const { session, data } = this._normalizeArgsForSave(...args);
      console.log(`💾 save called. session=${session}; dataPresent=${!!data}`);

      if (!data || (typeof data === 'object' && Object.keys(data).length === 0)) {
        console.log('⚠️ No data to save (empty payload). Returning without upsert.');
        return;
      }

      // If data is an object that can't be stored as-is, you might want to JSON.stringify
      // but supabase-js will accept JS object for jsonb column.
      await this._upsertRow(session, data);
      console.log(`✅ Supabase: session saved: ${session}`);
      return;
    } catch (err) {
      console.error('Error in save():', err);
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
        console.error('Supabase delete error:', error);
        throw error;
      }
      console.log('✅ delete successful');
    } catch (err) {
      console.error('delete exception:', err);
    }
  }

  // Provide aliases that some RemoteAuth versions may call
  async remove(sessionOrObj) {
    // alias
    if (typeof sessionOrObj === 'object') {
      return this.delete(sessionOrObj);
    }
    return this.delete({ session: sessionOrObj });
  }
}

export default SupabaseSessionStorage;
