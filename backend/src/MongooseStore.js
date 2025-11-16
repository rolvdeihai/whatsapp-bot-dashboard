// backend/src/MongooseStore.js
import mongoose from 'mongoose';
import { MongoStore } from 'wwebjs-mongo';

let store = null;
let isConnected = false;

export async function getMongooseStore() {
  if (store && isConnected) {
    return store;
  }

  try {
    const mongoUri = process.env.MONGO_URI;

    if (!mongoUri) {
      throw new Error('MONGO_URI is not defined in environment variables');
    }

    console.log('Connecting to MongoDB Atlas for RemoteAuth session storage...');

    await mongoose.connect(mongoUri, {
      dbName: 'whatsapp-sessions', // optional: separate DB
      maxPoolSize: 5,
      minPoolSize: 1,
      maxIdleTimeMS: 30000,
      serverSelectionTimeoutMS: 5000,
    });

    console.log('MongoDB connected successfully for RemoteAuth');

    store = new MongoStore({
      mongoose, // pass the connected instance
      autoReconnect: true,
    });

    isConnected = true;
    return store;
  } catch (error) {
    console.error('Failed to connect to MongoDB Atlas:', error.message);
    throw error;
  }
}

// Optional: Graceful shutdown
process.on('SIGINT', async () => {
  if (mongoose.connection.readyState === 1) {
    await mongoose.disconnect();
    console.log('MongoDB disconnected on app termination');
  }
  process.exit(0);
});