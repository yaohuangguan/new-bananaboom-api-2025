import { MongoClient } from 'mongodb';

// Each Workers request gets its own TCP connection. Never cache sockets across isolates.
async function withDatabase(work) {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not configured');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, maxPoolSize: 1 });
  try {
    await client.connect();
    return await work(client.db());
  } finally {
    await client.close();
  }
}

export const repository = {
  homepages: () => withDatabase((db) => db.collection('homepages').find({}).toArray()),
  likes: () => withDatabase((db) => db.collection('homepages').find({}, { projection: { likes: 1 } }).toArray()),
  projects: () => withDatabase((db) => db.collection('projects').find({}).toArray()),
  logs: () => withDatabase((db) => db.collection('logs').find({}).sort({ version: 1 }).toArray())
};
