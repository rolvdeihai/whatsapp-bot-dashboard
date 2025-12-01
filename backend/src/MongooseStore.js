// backend/src/MongooseStore.js
import mongoose from 'mongoose';
import { MongoStore } from 'wwebjs-mongo';

let store = null;
let isConnected = false;
let connectionPromise = null;

export async function getMongooseStore() {
  if (store && isConnected) {
    return store;
  }

  if (connectionPromise) {
    return await connectionPromise;
  }

  connectionPromise = (async () => {
    try {
      const mongoUri = process.env.MONGO_URI;

      if (!mongoUri) {
        throw new Error("MONGO_URI is not defined in environment variables");
      }

      console.log('🔗 Connecting to MongoDB Atlas for RemoteAuth session storage...');

      // Check if already connected
      if (mongoose.connection.readyState === 1) {
        console.log("✅ MongoDB already connected");
        store = new MongoStore({ mongoose, autoReconnect: true });
        isConnected = true;
        return store;
      }

      await mongoose.connect(mongoUri, {
        dbName: 'whatsapp-sessions',
        maxPoolSize: 5,
        minPoolSize: 1,
        maxIdleTimeMS: 30000,
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000,
      });

      console.log('✅ MongoDB connected successfully for RemoteAuth');

      store = new MongoStore({
        mongoose,
        autoReconnect: true,
      });

      isConnected = true;
      return store;
    } catch (error) {
      console.error('Failed to connect to MongoDB Atlas:', error.message);
      connectionPromise = null; // Reset to allow retry
      throw error;
    }
  })
  ();

  return await connectionPromise;
}

// Function to purge GridFS collections for RemoteAuth
export async function purgeSignalStoreCollections(forceFullPurge = false) {
  let db;
  try {
    db = await ensureMongoDBConnection();
    
    // These are the GridFS collections for RemoteAuth session storage
    const gridFSCollections = [
      'whatsapp-RemoteAuth-admin.files',
      'whatsapp-RemoteAuth-admin.chunks'
    ];

    let purgedCollections = [];
    let totalDeleted = 0;
    let estimatedSpaceFreed = 0;

    for (const collectionName of gridFSCollections) {
      try {
        const collection = db.collection(collectionName);
        
        // Get collection stats before purge
        const stats = await db.command({ collStats: collectionName });
        const sizeBefore = stats.size || 0;
        const countBefore = stats.count || 0;
        
        // Delete all documents in these GridFS collections
        const result = await collection.deleteMany({});
        totalDeleted += result.deletedCount;
        
        // Get collection stats after purge
        const statsAfter = await db.command({ collStats: collectionName });
        const sizeAfter = statsAfter.size || 0;
        const spaceFreed = Math.round((sizeBefore - sizeAfter) / 1024 / 1024);
        
        estimatedSpaceFreed += spaceFreed;
        purgedCollections.push(collectionName);
        
        console.log(`✅ Purged ${collectionName}: ${result.deletedCount} documents, freed ~${spaceFreed}MB`);
        
      } catch (collectionError) {
        console.log(`🔶 Collection ${collectionName} not found or error purging:`, collectionError.message);
      }
    }

    // Also try to purge any other potential RemoteAuth collections
    const otherCollectionsToCheck = [
      'sessions',
      'RemoteAuth-sessions',
      'whatsapp-sessions'
    ];

    for (const collectionName of otherCollectionsToCheck) {
      try {
        const collection = db.collection(collectionName);
        const result = await collection.deleteMany({ 
          _id: { $regex: /RemoteAuth|whatsapp/ } 
        });
        
        if (result.deletedCount > 0) {
          console.log(`✅ Purged ${collectionName}: ${result.deletedCount} documents`);
          purgedCollections.push(collectionName);
          totalDeleted += result.deletedCount;
        }
      } catch (collectionError) {
        // Ignore errors for collections that don't exist
      }
    }

    return {
      success: true,
      purgedCollections,
      totalDocumentsDeleted: totalDeleted,
      estimatedSpaceFreed,
      forceFullPurge
    };

  } catch (error) {
    console.error('❌ Error purging GridFS collections:', error);
    return {
      success: false,
      error: error.message,
      purgedCollections: [],
      totalDocumentsDeleted: 0,
      estimatedSpaceFreed: 0
    };
  }
}

// Function to get specific GridFS collection sizes
export async function getGridFSSizes() {
  try {
    const db = await ensureMongoDBConnection();
    
    const gridFSCollections = [
      'whatsapp-RemoteAuth-admin.files',
      'whatsapp-RemoteAuth-admin.chunks'
    ];
    
    const sizes = {};
    let totalSize = 0;
    
    for (const collectionName of gridFSCollections) {
      try {
        const stats = await db.command({ collStats: collectionName });
        const sizeMB = Math.round((stats.size || 0) / 1024 / 1024);
        const storageSizeMB = Math.round((stats.storageSize || 0) / 1024 / 1024);
        const count = stats.count || 0;
        
        sizes[collectionName] = {
          sizeMB,
          storageSizeMB,
          count
        };
        
        totalSize += stats.size || 0;
        
      } catch (e) {
        console.log(`🔶 Could not get stats for ${collectionName}:`, e.message);
      }
    }
    
    return {
      gridFSSizes: sizes,
      totalGridFSSizeMB: Math.round(totalSize / 1024 / 1024)
    };
  } catch (error) {
    console.error('Error getting GridFS sizes:', error);
    throw error;
  }
}

// Function to get MongoDB database size (including GridFS)
export async function getMongoDBSize() {
  try {
    const db = await ensureMongoDBConnection();
    const stats = await db.stats();
    
    return stats.dataSize + stats.indexSize; // Total size in bytes
    
  } catch (error) {
    console.error('Error getting MongoDB size:', error);
    throw error;
  }
}

// Function to get detailed database information
export async function getDatabaseInfo() {
  try {
    const db = await ensureMongoDBConnection();
    const stats = await db.stats();
    const collections = await db.listCollections().toArray();
    const gridFSSizes = await getGridFSSizes();
    
    const collectionSizes = {};
    for (const collection of collections) {
      try {
        const collStats = await db.command({ collStats: collection.name });
        collectionSizes[collection.name] = {
          sizeMB: Math.round((collStats.size || 0) / 1024 / 1024),
          storageSizeMB: Math.round((collStats.storageSize || 0) / 1024 / 1024),
          count: collStats.count || 0
        };
      } catch (e) {
        // Ignore collections that can't be stats'd
      }
    }
    
    return {
      dbStats: {
        dataSizeMB: Math.round(stats.dataSize / 1024 / 1024),
        storageSizeMB: Math.round(stats.storageSize / 1024 / 1024),
        indexSizeMB: Math.round(stats.indexSize / 1024 / 1024),
        totalSizeMB: Math.round((stats.dataSize + stats.indexSize) / 1024 / 1024),
        collections: stats.collections || 0
      },
      gridFSSizes: gridFSSizes.gridFSSizes,
      totalGridFSSizeMB: gridFSSizes.totalGridFSSizeMB,
      allCollections: collectionSizes,
      collectionNames: collections.map(c => c.name)
    };
  } catch (error) {
    console.error('Error getting database info:', error);
    throw error;
  }
}

// Function to ensure MongoDB connection
async function ensureMongoDBConnection() {
  try {
    if (mongoose.connection.readyState === 1) {
      return mongoose.connection.db;
    }
    
    await getMongooseStore(); // This will establish connection if needed
    return mongoose.connection.db;
  } catch (error) {
    console.error('Failed to ensure MongoDB connection:', error);
    throw error;
  }
}

// Check if MongoDB is connected
export function isMongoDBConnected() {
  return mongoose.connection.readyState === 1;
}

// Optional: Graceful shutdown
process.on('SIGINT', async () => {
  if (mongoose.connection.readyState === 1) {
    await mongoose.disconnect();
    console.log('MongoDB disconnected on app termination');
  }
  process.exit(0);
});