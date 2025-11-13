// backend/src/SupabaseSessionStorage.js
import { createClient } from '@supabase/supabase-js';

class SupabaseSessionStorage {
  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );
  }

  // =============================================
  // RemoteAuth Store Interface (Required Methods)
  // =============================================

  /**
   * Session exists check - REQUIRED by RemoteAuth
   */
  async sessionExists({ session }) {
    try {
      console.log(`🔍 RemoteAuth sessionExists: ${session}`);
      
      const { data, error } = await this.supabase
        .from('whatsapp_sessions')
        .select('session_data')
        .eq('session_id', session)
        .single();

      if (error || !data) {
        console.log(`❌ Session not found: ${session}`);
        return false;
      }

      const sessionData = data.session_data;
      
      if (!sessionData || 
          (typeof sessionData === 'object' && Object.keys(sessionData).length === 0)) {
        console.log('🗑️ Empty session data found, deleting...');
        await this.delete({ session });
        return false;
      }

      console.log(`✅ Session exists: ${session}`);
      return true;

    } catch (error) {
      console.error('❌ Error in sessionExists:', error);
      return false;
    }
  }

  /**
   * Extract session data - REQUIRED by RemoteAuth
   */
  async extract({ session }) {
    try {
      console.log(`🔍 RemoteAuth extract: ${session}`);
      
      const { data, error } = await this.supabase
        .from('whatsapp_sessions')
        .select('session_data')
        .eq('session_id', session)
        .single();

      if (error || !data) {
        console.log(`❌ Session not found for extract: ${session}`);
        return null;
      }

      const sessionData = data.session_data;
      
      if (!sessionData) {
        return null;
      }

      console.log(`✅ Session data extracted for: ${session}`);
      return sessionData;

    } catch (error) {
      console.error('❌ Error in extract:', error);
      return null;
    }
  }

  /**
   * Save session data - REQUIRED by RemoteAuth
   */
  async save({ session, data }) {
    try {
      console.log(`💾 RemoteAuth save: ${session}`);
      
      if (!data) {
        console.log('⚠️ No data to save');
        return;
      }

      console.log(`📦 Saving session data type: ${typeof data}, size: ${JSON.stringify(data).length} chars`);

      const { error } = await this.supabase
        .from('whatsapp_sessions')
        .upsert({
          session_id: session,
          session_data: data,
          updated_at: new Date().toISOString(),
        }, {
          onConflict: 'session_id'
        });

      if (error) {
        console.error('❌ RemoteAuth save error:', error);
        throw error;
      }
      
      console.log(`✅ Session data saved: ${session}`);
        
    } catch (error) {
      console.error('❌ Error in save:', error);
    }
  }

  /**
   * Delete session - REQUIRED by RemoteAuth
   */
  async delete({ session }) {
    try {
      console.log(`🗑️ RemoteAuth delete: ${session}`);
      
      const { error } = await this.supabase
        .from('whatsapp_sessions')
        .delete()
        .eq('session_id', session);

      if (error) throw error;
      console.log(`✅ Session deleted: ${session}`);
    } catch (error) {
      console.error('❌ Error in delete:', error);
    }
  }
}

export default SupabaseSessionStorage;