// backend/src/SupabaseRemoteAuthStore.js
import { supabase } from './supabaseClient.js';
import { promises as fs } from 'fs'; // Add fs import
import path from 'path';

export class SupabaseRemoteAuthStore {
  constructor(clientId) {
    this.clientId = clientId;
    this.tableName = 'whatsapp_sessions';
    this.chunksTableName = 'whatsapp_session_chunks';
    this.initTables();
  }

  async initTables() {
    try {
      // Create sessions table if it doesn't exist
      const { error: sessionsError } = await supabase
        .from(this.tableName)
        .select('*')
        .limit(1);

      if (sessionsError && sessionsError.code === '42P01') { // Table doesn't exist
        console.log('Creating sessions table...');
        // You would need to create this table in Supabase manually
      }

      // Create chunks table if it doesn't exist
      const { error: chunksError } = await supabase
        .from(this.chunksTableName)
        .select('*')
        .limit(1);

      if (chunksError && chunksError.code === '42P01') {
        console.log('Creating chunks table...');
      }

      console.log('✅ Supabase store initialized for client:', this.clientId);
    } catch (error) {
      console.error('Error initializing Supabase tables:', error);
    }
  }

  // Store session data (GridFS-like storage)
  async sessionExists(options) {
    try {
      const sessionId = `${this.clientId}-${options.session}`;
      const { data, error } = await supabase
        .from(this.tableName)
        .select('id')
        .eq('id', sessionId)
        .single();

      if (error && error.code !== 'PGRST116') { // No rows found
        console.error('Error checking session:', error);
        return false;
      }

      return !!data;
    } catch (error) {
      console.error('Error in sessionExists:', error);
      return false;
    }
  }

  // Updated save method - reads from the zip file created by RemoteAuth
  async save(options) {
    try {
      const sessionId = `${this.clientId}-${options.session}`;
      const zipFileName = `${options.session}.zip`;
      
      console.log(`🔄 Save called for session: ${sessionId}, zip file: ${zipFileName}`);
      
      // Check if zip file exists
      try {
        await fs.access(zipFileName);
      } catch (error) {
        console.error(`❌ Zip file ${zipFileName} not found. Current directory: ${process.cwd()}`);
        return false;
      }
      
      // Read the compressed session zip file
      const sessionData = await fs.readFile(zipFileName);
      console.log(`📦 Read session zip file: ${zipFileName} (${sessionData.length} bytes)`);
      
      if (!sessionData || sessionData.length === 0) {
        console.warn('⚠️ Empty session data in zip file');
        return false;
      }
      
      // Convert session data to base64 for storage
      const base64Data = sessionData.toString('base64');
      
      // Split into chunks if data is too large
      const chunkSize = 1024 * 1024; // 1MB chunks
      const chunks = [];
      
      for (let i = 0; i < base64Data.length; i += chunkSize) {
        chunks.push(base64Data.substring(i, i + chunkSize));
      }

      // ✅ FIX: Insert session metadata FIRST
      const { error: sessionError } = await supabase
        .from(this.tableName)
        .upsert({
          id: sessionId,
          session: sessionId,
          client_id: this.clientId,
          chunks_count: chunks.length,
          total_size: base64Data.length,
          last_accessed: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'id'
        });

      if (sessionError) throw sessionError;
      console.log(`✅ Session metadata created: ${sessionId}`);

      // ✅ FIX: Delete existing chunks first
      const { error: deleteChunksError } = await supabase
        .from(this.chunksTableName)
        .delete()
        .eq('session_id', sessionId);

      if (deleteChunksError) {
        console.error('Error deleting chunks:', deleteChunksError);
        // Continue anyway, might be first time
      }

      // Save each chunk
      for (let i = 0; i < chunks.length; i++) {
        const { error } = await supabase
          .from(this.chunksTableName)
          .upsert({
            session_id: sessionId,
            chunk_index: i,
            chunk_data: chunks[i],
            total_chunks: chunks.length,
            updated_at: new Date().toISOString()
          }, {
            onConflict: 'session_id,chunk_index'
          });

        if (error) {
          console.error(`❌ Error saving chunk ${i}:`, error);
          throw error;
        }
      }

      console.log(`✅ Session saved to Supabase: ${sessionId} (${chunks.length} chunks, ${Math.round(sessionData.length / 1024)}KB)`);
      return true;
    } catch (error) {
      console.error('❌ Error saving session to Supabase:', error);
      return false;
    }
  }

  // Extract session from chunks and write to file
  async extract(options) {
    try {
      const sessionId = `${this.clientId}-${options.session}`;
      const outputPath = options.path;
      
      console.log(`🔄 Extracting session to: ${outputPath} for session: ${sessionId}`);
      
      // Get all chunks for this session
      const { data: chunks, error } = await supabase
        .from(this.chunksTableName)
        .select('chunk_index, chunk_data, total_chunks')
        .eq('session_id', sessionId)
        .order('chunk_index', { ascending: true });

      if (error) throw error;
      
      if (!chunks || chunks.length === 0) {
        console.log('No session chunks found for:', sessionId);
        return null;
      }

      // Reconstruct the base64 string
      let base64Data = '';
      for (const chunk of chunks) {
        base64Data += chunk.chunk_data;
      }

      // Convert back to Buffer
      const sessionData = Buffer.from(base64Data, 'base64');

      // Write the buffer to the output file
      await fs.writeFile(outputPath, sessionData);
      console.log(`✅ Session extracted to file: ${outputPath} (${sessionData.length} bytes)`);

      // Update last accessed time
      await supabase
        .from(this.tableName)
        .update({ 
          last_accessed: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', sessionId);

      console.log(`✅ Session extracted from Supabase: ${sessionId} (${chunks.length} chunks)`);
      return sessionData;
    } catch (error) {
      console.error('❌ Error extracting session from Supabase:', error);
      return null;
    }
  }

  // Delete session and all chunks
  async delete(options) {
    try {
      const sessionId = `${this.clientId}-${options.session}`;
      
      // ✅ FIX: Delete chunks first to avoid foreign key constraint issues
      const { error: chunksError } = await supabase
        .from(this.chunksTableName)
        .delete()
        .eq('session_id', sessionId);

      if (chunksError) console.error('Error deleting chunks:', chunksError);

      // Then delete session metadata
      const { error } = await supabase
        .from(this.tableName)
        .delete()
        .eq('id', sessionId);

      if (error) throw error;

      console.log(`✅ Session deleted from Supabase: ${sessionId}`);
      return true;
    } catch (error) {
      console.error('Error deleting session from Supabase:', error);
      return false;
    }
  }

  // List all sessions for this client
  async list() {
    try {
      const { data, error } = await supabase
        .from(this.tableName)
        .select('id, client_id, chunks_count, total_size, last_accessed, updated_at')
        .eq('client_id', this.clientId);

      if (error) throw error;

      return data || [];
    } catch (error) {
      console.error('Error listing sessions:', error);
      return [];
    }
  }

  // Get session info
  async getSessionInfo(options) {
    try {
      const sessionId = `${this.clientId}-${options.session}`;
      
      const { data, error } = await supabase
        .from(this.tableName)
        .select('*')
        .eq('id', sessionId)
        .single();

      if (error) throw error;

      return data;
    } catch (error) {
      console.error('Error getting session info:', error);
      return null;
    }
  }

  // Clean up old sessions (older than specified hours)
  async cleanupOldSessions(maxAgeHours = 24) {
    try {
      const cutoffTime = new Date(Date.now() - (maxAgeHours * 60 * 60 * 1000)).toISOString();
      
      // Find old sessions
      const { data: oldSessions, error } = await supabase
        .from(this.tableName)
        .select('id')
        .lt('last_accessed', cutoffTime)
        .eq('client_id', this.clientId);

      if (error) throw error;

      let deletedCount = 0;
      
      // Delete each old session
      for (const session of oldSessions) {
        const sessionId = session.id;
        const baseSession = sessionId.replace(`${this.clientId}-`, '');
        
        await this.delete({ session: baseSession });
        deletedCount++;
      }

      console.log(`🧹 Cleaned up ${deletedCount} old sessions from Supabase`);
      return deletedCount;
    } catch (error) {
      console.error('Error cleaning up old sessions:', error);
      return 0;
    }
  }

  // Get storage statistics
  async getStorageStats() {
    try {
      const { data: sessions, error } = await supabase
        .from(this.tableName)
        .select('total_size, chunks_count')
        .eq('client_id', this.clientId);

      if (error) throw error;

      const totalSize = sessions.reduce((sum, session) => sum + (session.total_size || 0), 0);
      const totalChunks = sessions.reduce((sum, session) => sum + (session.chunks_count || 0), 0);
      
      return {
        sessionsCount: sessions.length,
        totalSize: totalSize,
        totalSizeMB: Math.round(totalSize / 1024 / 1024 * 100) / 100,
        totalChunks: totalChunks,
        lastUpdated: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error getting storage stats:', error);
      return {
        sessionsCount: 0,
        totalSize: 0,
        totalSizeMB: 0,
        totalChunks: 0,
        lastUpdated: new Date().toISOString()
      };
    }
  }
}