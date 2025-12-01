// whatsapp-bot-dashboard/backend/src/SupabaseRemoteAuthStore.js

import pkg from 'whatsapp-web.js';
const { BaseAuthStore } = pkg;
import { supabase } from './supabaseClient.js';

/**
 * Custom RemoteAuth store that uses Supabase Storage for session backup
 */
class SupabaseRemoteAuthStore extends BaseAuthStore {
  constructor(clientId, options = {}) {
    super();
    this.clientId = clientId;
    this.bucketName = options.bucketName || 'whatsapp-sessions';
    this.backupFileName = `RemoteAuth-${clientId}.zip`;
    this.localBackupPath = options.localBackupPath || './backups';
  }

  async sessionExists() {
    try {
      const { data, error } = await supabase.storage
        .from(this.bucketName)
        .list('', {
          search: this.backupFileName
        });

      if (error) throw error;
      
      return data.some(file => file.name === this.backupFileName);
    } catch (error) {
      console.error('Error checking session existence:', error);
      return false;
    }
  }

  async save(session) {
    // This method is called by RemoteAuth to save the session
    // We don't need to implement this since RemoteAuth handles backup files automatically
    console.log('Session save triggered - RemoteAuth will create backup file');
  }

  async extract() {
    // This method should return the session data
    // Since we're relying on backup files, we return null to force backup restoration
    return null;
  }

  async delete() {
    try {
      const { error } = await supabase.storage
        .from(this.bucketName)
        .remove([this.backupFileName]);

      if (error) throw error;
      
      console.log('✅ Session deleted from Supabase');
      return true;
    } catch (error) {
      console.error('Error deleting session:', error);
      return false;
    }
  }

  // Upload backup to Supabase
  async uploadBackup(backupPath) {
    try {
      const fs = await import('fs-extra');
      
      if (!fs.existsSync(backupPath)) {
        console.log('Backup file not found at:', backupPath);
        return false;
      }

      const fileBuffer = fs.readFileSync(backupPath);
      
      const { data, error } = await supabase.storage
        .from(this.bucketName)
        .upload(this.backupFileName, fileBuffer, {
          upsert: true,
          contentType: 'application/zip'
        });

      if (error) {
        // If bucket doesn't exist, create it
        if (error.message.includes('bucket')) {
          await this.createBucket();
          return await this.uploadBackup(backupPath);
        }
        throw error;
      }

      console.log('✅ Backup uploaded to Supabase:', this.backupFileName);
      return true;
    } catch (error) {
      console.error('❌ Error uploading backup:', error);
      return false;
    }
  }

  // Download backup from Supabase
  async downloadBackup() {
    try {
      const fs = await import('fs-extra');
      const path = await import('path');
      
      // Ensure local backup directory exists
      if (!fs.existsSync(this.localBackupPath)) {
        fs.mkdirSync(this.localBackupPath, { recursive: true });
      }

      const { data, error } = await supabase.storage
        .from(this.bucketName)
        .download(this.backupFileName);

      if (error) {
        console.log('No backup found in Supabase');
        return null;
      }

      // Convert blob to buffer and save
      const arrayBuffer = await data.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      
      const localPath = path.join(this.localBackupPath, this.backupFileName);
      fs.writeFileSync(localPath, buffer);
      
      console.log('✅ Backup downloaded from Supabase:', this.backupFileName);
      return localPath;
    } catch (error) {
      console.error('❌ Error downloading backup:', error);
      return null;
    }
  }

  // Create bucket if it doesn't exist
  async createBucket() {
    try {
      const { data, error } = await supabase.storage.createBucket(this.bucketName, {
        public: false,
        fileSizeLimit: 10485760, // 10MB limit for session files
      });

      if (error && !error.message.includes('already exists')) {
        throw error;
      }

      console.log('✅ Bucket created or already exists');
      return true;
    } catch (error) {
      console.error('❌ Error creating bucket:', error);
      return false;
    }
  }

  // Get backup info
  async getBackupInfo() {
    try {
      const { data, error } = await supabase.storage
        .from(this.bucketName)
        .list('', {
          search: this.backupFileName
        });

      if (error) throw error;

      const backupFile = data.find(file => file.name === this.backupFileName);
      return backupFile || null;
    } catch (error) {
      console.error('Error getting backup info:', error);
      return null;
    }
  }
}

export default SupabaseRemoteAuthStore;