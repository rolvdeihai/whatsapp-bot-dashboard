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
   * Get session data by session ID - REQUIRED by RemoteAuth
   */
  async get(sessionId) {
    try {
      console.log(`🔍 RemoteAuth GET session: ${sessionId}`);
      
      const { data, error } = await this.supabase
        .from('whatsapp_sessions')
        .select('session_data')
        .eq('session_id', sessionId)
        .single();

      if (error || !data) {
        console.log(`❌ Session not found: ${sessionId}`);
        return null;
      }

      const sessionData = data.session_data;
      
      if (!sessionData || 
          (typeof sessionData === 'object' && Object.keys(sessionData).length === 0)) {
        console.log('🗑️ Empty session data found, deleting...');
        await this.remove(sessionId);
        return null;
      }

      console.log(`✅ Session data retrieved for: ${sessionId}`);
      return sessionData;

    } catch (error) {
      console.error('❌ Error in RemoteAuth get:', error);
      return null;
    }
  }

  /**
   * Save session data - REQUIRED by RemoteAuth
   */
  async set(sessionId, sessionData) {
    try {
      console.log(`💾 RemoteAuth SET session: ${sessionId}`);
      
      if (!sessionData || (typeof sessionData === 'object' && Object.keys(sessionData).length === 0)) {
        console.log('⚠️ No valid data to save');
        return;
      }

      const { error } = await this.supabase
        .from('whatsapp_sessions')
        .upsert({
          session_id: sessionId,
          session_data: sessionData,
          updated_at: new Date().toISOString(),
        }, {
          onConflict: 'session_id'
        });

      if (error) {
        console.error('❌ RemoteAuth set error:', error);
        throw error;
      }
      
      console.log(`✅ Session data saved via RemoteAuth: ${sessionId}`);
        
    } catch (error) {
      console.error('❌ Error in RemoteAuth set:', error);
    }
  }

  /**
   * Delete session - REQUIRED by RemoteAuth
   */
  async remove(sessionId) {
    try {
      console.log(`🗑️ RemoteAuth REMOVE session: ${sessionId}`);
      
      const { error } = await this.supabase
        .from('whatsapp_sessions')
        .delete()
        .eq('session_id', sessionId);

      if (error) throw error;
      console.log(`✅ Session deleted via RemoteAuth: ${sessionId}`);
    } catch (error) {
      console.error('❌ Error in RemoteAuth remove:', error);
    }
  }

  /**
   * List all sessions - REQUIRED by RemoteAuth
   */
  async list() {
    try {
      console.log('📋 RemoteAuth LIST sessions');
      
      const { data, error } = await this.supabase
        .from('whatsapp_sessions')
        .select('session_id, session_data');

      if (error) {
        console.error('❌ RemoteAuth list error:', error);
        return [];
      }

      const sessions = data.map(row => ({
        id: row.session_id,
        session: row.session_data
      }));

      console.log(`✅ Found ${sessions.length} sessions via RemoteAuth`);
      return sessions;

    } catch (error) {
      console.error('❌ Error in RemoteAuth list:', error);
      return [];
    }
  }

  // =============================================
  // Legacy Methods (For Backward Compatibility)
  // =============================================

  /**
   * Legacy method - checks if session exists
   */
  async sessionExists(session) {
    try {
      const sessionData = await this.get(session);
      return sessionData !== null;
    } catch (error) {
      console.error('❌ Error in sessionExists:', error);
      return false;
    }
  }

  /**
   * Legacy method - extract session data
   */
  async extract(session) {
    return await this.get(session);
  }

  /**
   * Legacy method - save session data with old signature
   */
  async save({ session, data }) {
    return await this.set(session, data);
  }

  /**
   * Legacy method - delete session with old signature
   */
  async delete({ session }) {
    return await this.remove(session);
  }
}

export default SupabaseSessionStorage;