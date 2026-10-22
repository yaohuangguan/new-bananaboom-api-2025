// Operator import: explicit owner, default preview, no content or credentials in output.
import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import User from '../models/User.js';
import { previewKnowledge, importKnowledge } from '../services/brain/knowledge.js';
const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
if (!args.includes('--owner-email') || !args.includes('--file') || !process.env.MONGO_URI) {
  console.error('Usage: MONGO_URI=... node scripts/import-brain-knowledge.mjs --owner-email EMAIL --file FILE [--commit --allow-production]');
  process.exit(2);
}
if (process.env.NODE_ENV === 'production' && !args.includes('--allow-production')) {
  console.error('Production requires explicit --allow-production and an authorized owner import.'); process.exit(2);
}
try {
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, serverSelectionTimeoutMS: 15000 });
  const email = value('--owner-email').trim().toLowerCase();
  const user = await User.findOne({ email }).select('_id').lean();
  if (!user) throw new Error('OWNER_ACCOUNT_NOT_FOUND');
  const file = value('--file'), bytes = await fs.readFile(file), owner = String(user._id);
  const preview = await previewKnowledge(owner, bytes);
  if (!args.includes('--commit')) console.log(JSON.stringify({ ...preview, committed: false, ownerId: owner }));
  else {
    const result = await importKnowledge(owner, bytes, path.basename(file));
    console.log(JSON.stringify({ ...result, committed: true, ownerId: owner }));
  }
} catch (e) {
  console.error(JSON.stringify({ error: e.status ? e.message : 'IMPORT_FAILED', name: e.name }));
  process.exitCode = 1;
} finally { await mongoose.disconnect(); }
