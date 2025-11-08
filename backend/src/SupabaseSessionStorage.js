// backend/src/SupabaseSessionStorage.js
import { createClient } from '@supabase/supabase-js';

class SupabaseSessionStorage {
  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );
  }

  async sessionExists(session) {
    try {
      const { data, error } = await this.supabase
        .from('whatsapp_sessions')
        .select('session_data')
        .eq('session_id', session)
        .single();

      if (error || !data) {
        return false;
      }

      const sessionData = data.session_data;
      
      if (!sessionData || 
          (typeof sessionData === 'object' && Object.keys(sessionData).length === 0)) {
        console.log('🗑️ Empty session data found');
        await this.delete(session);
        return false;
      }

      return true;
    } catch (error) {
      console.error('❌ Error checking session existence:', error);
      return false;
    }
  }

  async save({ session, data }) {
    try {
      console.log('💾 Saving session data to Supabase...');
      
      if (!data || (typeof data === 'object' && Object.keys(data).length === 0)) {
        console.log('⚠️ No valid data to save');
        return;
      }

      // 🚀 MERGE with existing data
      const { data: existingData, error: selectError } = await this.supabase
        .from('whatsapp_sessions')
        .select('session_data')
        .eq('session_id', session)
        .single();

      let mergedData = data;

      if (!selectError && existingData && existingData.session_data) {
        console.log('🔄 Merging with existing session data...');
        
        if (typeof existingData.session_data === 'string') {
          try {
            const parsedExisting = JSON.parse(existingData.session_data);
            mergedData = { ...parsedExisting, ...data };
          } catch (parseError) {
            console.log('⚠️ Could not parse existing data, overwriting...');
            mergedData = data;
          }
        } else if (typeof existingData.session_data === 'object') {
          mergedData = { ...existingData.session_data, ...data };
        }
      }

      console.log(`✅ Saving merged data with keys: ${Object.keys(mergedData).join(', ')}`);

      const { error } = await this.supabase
        .from('whatsapp_sessions')
        .upsert({
          session_id: session,
          session_data: mergedData,
          updated_at: new Date().toISOString(),
        }, {
          onConflict: 'session_id'
        });

      if (error) {
        console.error('❌ Supabase save error:', error);
        throw error;
      }
      
      console.log('✅ Session data saved to Supabase');
        
    } catch (error) {
      console.error('❌ Error saving session:', error);
    }
  }

  async extract(session) {
    try {
      const { data, error } = await this.supabase
        .from('whatsapp_sessions')
        .select('session_data, updated_at')
        .eq('session_id', session)
        .single();

      if (error || !data) {
        return null;
      }

      const sessionData = data.session_data;
      
      if (!sessionData) {
        return null;
      }

      let parsedData;
      if (typeof sessionData === 'string') {
        try {
          parsedData = JSON.parse(sessionData);
        } catch (parseError) {
          return null;
        }
      } else {
        parsedData = sessionData;
      }

      if (typeof parsedData === 'object' && Object.keys(parsedData).length === 0) {
        await this.delete(session);
        return null;
      }

      return parsedData;

    } catch (error) {
      console.error('❌ Error extracting session:', error);
      return null;
    }
  }

  async delete({ session }) {
    try {
      const { error } = await this.supabase
        .from('whatsapp_sessions')
        .delete()
        .eq('session_id', session);

      if (error) throw error;
      console.log('✅ Session deleted from Supabase');
    } catch (error) {
      console.error('❌ Error deleting session:', error);
    }
  }
}

export default SupabaseSessionStorage;