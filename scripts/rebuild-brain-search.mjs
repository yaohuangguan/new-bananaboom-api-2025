// Owner-scoped local maintenance only. Default is a read-only plan.
import mongoose from 'mongoose';
import { BrainDocument, BrainMemory } from '../models/brain.js';
import { objectId, searchFields } from '../services/brain/core.js';
try {
  const ownerId = objectId(process.argv[2]);
  const uri = new URL(process.env.MONGO_URI || '');
  if (process.env.NODE_ENV === 'production' || !['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname))
    throw new Error('LOCAL_DATASET_REQUIRED');
  await mongoose.connect(uri.toString());
  const commit = process.argv.includes('--commit');
  const counts = {};
  for (const [name, Model, field] of [
    ['documents', BrainDocument, 'rawText'],
    ['memories', BrainMemory, 'statement']
  ]) {
    counts[name] = 0;
    for await (const row of Model.find({ ownerId })
      .select('_id ' + field)
      .lean()
      .cursor()) {
      counts[name]++;
      if (commit)
        await Model.updateOne({ _id: row._id, ownerId }, { $set: searchFields(row[field]) }, { timestamps: false });
    }
  }
  console.log(JSON.stringify({ committed: commit, counts }));
} catch {
  console.error('REINDEX_FAILED_LOCAL_URI_AND_OWNER_REQUIRED');
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
