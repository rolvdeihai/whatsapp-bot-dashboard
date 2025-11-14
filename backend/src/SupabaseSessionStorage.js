// backend/src/SupabaseSessionStorage.js
import { createClient } from '@supabase/supabase-js';

class SupabaseSessionStorage {
  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );
  }

  async sessionExists({ session }) {
    try {
      console.log(`🔍 sessionExists called with session=${session}`);
      const { data, error } = await this.supabase
        .from('whatsapp_sessions')
        .select('session_data')
        .eq('session_id', session)
        .maybeSingle();

      if (error || !data || !data.session_data) {
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

  async extract({ session }) {
    try {
      console.log(`🔍 extract called for session=${session}`);
      const { data, error } = await this.supabase
        .from('whatsapp_sessions')
        .select('session_data')
        .eq('session_id', session)
        .maybeSingle();

      if (error || !data) {
        console.log('❌ No session data found for extract');
        return null;
      }

      const sessionData = data.session_data;
      
      // Check if session data is a ZIP file (Buffer or base64)
      if (sessionData && sessionData._zip) {
        console.log('📦 Extracting ZIP session data');
        // This is a ZIP file stored as base64
        return Buffer.from(sessionData.data, 'base64');
      }
      
      // Regular session data
      console.log('📄 Extracting regular session data');
      return sessionData;

    } catch (err) {
      console.error('❌ extract exception:', err);
      return null;
    }
  }

  async save({ session, data }) {
    try {
      console.log(`💾 save called. session=${session}; dataPresent=${!!data}`);
      
      if (!data) {
        console.log('⚠️ No data to save');
        return;
      }

      let sessionDataToSave;
      
      // Check if data is a Buffer (ZIP file)
      if (Buffer.isBuffer(data)) {
        console.log('📦 Detected ZIP buffer data, converting to base64');
        sessionDataToSave = {
          _zip: true,
          data: data.toString('base64'),
          saved_at: new Date().toISOString()
        };
      } 
      // Check if data is an object with WABrowserId and WAToken (session data)
      else if (typeof data === 'object' && data.WABrowserId && data.WAToken1) {
        console.log('🔑 Detected session credentials data');
        sessionDataToSave = {
          ...data,
          _type: 'session_credentials',
          saved_at: new Date().toISOString()
        };
      }
      // Regular object data
      else if (typeof data === 'object') {
        console.log('📄 Detected regular session data');
        sessionDataToSave = {
          ...data,
          _type: 'session_data',
          saved_at: new Date().toISOString()
        };
      }
      // Unknown data type
      else {
        console.log('❓ Unknown data type, storing as-is');
        sessionDataToSave = data;
      }

      console.log(`💽 Saving session data type: ${typeof sessionDataToSave}`);

      const { error } = await this.supabase
        .from('whatsapp_sessions')
        .upsert({
          session_id: session,
          session_data: sessionDataToSave,
          updated_at: new Date().toISOString(),
        }, {
          onConflict: 'session_id'
        });

      if (error) {
        console.error('❌ Supabase save error:', error);
        throw error;
      }
      
      console.log(`✅ Supabase: session saved: ${session}`);
        
    } catch (error) {
      console.error('❌ Error in save:', error);
    }
  }

  async delete({ session }) {
    try {
      console.log(`🗑️ delete called for session=${session}`);
      const { error } = await this.supabase
        .from('whatsapp_sessions')
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

  // RemoteAuth store interface methods
  async get(sessionId) {
    return await this.extract({ session: sessionId });
  }

  async set(sessionId, data) {
    return await this.save({ session: sessionId, data });
  }

  async remove(sessionId) {
    return await this.delete({ session: sessionId });
  }
}

export default SupabaseSessionStorage;