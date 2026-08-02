import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';

// Parse .env manually for Node.js compatibility
try {
  const envPath = path.resolve('.env');
  if (fs.existsSync(envPath)) {
    const envConfig = fs.readFileSync(envPath, 'utf8');
    envConfig.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...values] = trimmed.split('=');
        const val = values.join('=').trim().replace(/^['"]|['"]$/g, '');
        process.env[key.trim()] = val;
      }
    });
    console.log('Loaded env variables manually.');
  }
} catch (e) {
  console.warn('Failed to load .env manually:', e.message);
}

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/orion';

// Import models dynamically
const { default: User } = await import('../models/User.js');
const { default: Resume } = await import('../models/Resume.js');

async function performSwapAndRefactor() {
  console.log('🔌 Connecting to MongoDB...');
  await mongoose.connect(MONGO_URI);
  console.log('✅ Connected to MongoDB!');

  try {
    // 1. Ensure target accounts exist in the database (create if missing)
    const targets = [
      { email: 'moviegoer24@gmail.com', displayName: 'User_moviegoer24' },
      { email: 'cenniferchen@gmail.com', displayName: 'User_cennifer' }
    ];

    for (const t of targets) {
      let u = await User.findOne({ email: t.email });
      if (!u) {
        console.log(`➕ Target user [${t.email}] not found. Creating placeholder user document...`);
        u = new User({
          email: t.email,
          displayName: t.displayName,
          isProfileCompleted: false,
          role: 'user'
        });
        await u.save();
      }
    }

    // 2. Perform Swap 1: yaob@miamioh.edu ⇄ moviegoer24@gmail.com
    await executeDocumentIdentitySwap('yaob@miamioh.edu', 'moviegoer24@gmail.com');

    // 3. Perform Swap 2: cft_cool@hotmail.com ⇄ cenniferchen@gmail.com
    await executeDocumentIdentitySwap('cft_cool@hotmail.com', 'cenniferchen@gmail.com');

    // 4. Refactor all Resumes: Link existing string emails to their current owner's User ObjectIds
    await convertResumesToObjectIdLinks();

  } catch (error) {
    console.error('❌ Migration failed:', error);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB.');
  }
}

async function executeDocumentIdentitySwap(email1, email2) {
  console.log(`\n🔄 Swapping credentials & identities between [${email1}] ⇄ [${email2}]...`);
  const u1 = await User.findOne({ email: email1 });
  const u2 = await User.findOne({ email: email2 });

  if (!u1 || !u2) {
    throw new Error(`Users not found for swap: ${email1} (${!!u1}), ${email2} (${!!u2})`);
  }

  const identityFields = ['email', 'password', 'googleId', 'phone', 'barkUrl'];

  // Temporary unique email placeholder
  const tempEmail = `temp_swap_${Date.now()}_${Math.floor(Math.random() * 1000)}@migration.temp`;

  // Step A: Backup User 1 credentials & move User 1 to temporary values
  const u1Backup = {};
  identityFields.forEach(f => {
    u1Backup[f] = u1[f];
  });

  console.log(`  - Moving ${email1} to temporary placeholder...`);
  await User.updateOne(
    { _id: u1._id },
    { $set: { email: tempEmail }, $unset: { googleId: 1, phone: 1 } }
  );

  // Step B: Set User 2 credentials to User 1's backup
  console.log(`  - Setting ${email2} identity to ${email1}...`);
  await User.updateOne(
    { _id: u2._id },
    {
      $set: {
        email: u1Backup.email,
        password: u1Backup.password,
        barkUrl: u1Backup.barkUrl,
        ...(u1Backup.googleId ? { googleId: u1Backup.googleId } : {}),
        ...(u1Backup.phone ? { phone: u1Backup.phone } : {})
      },
      ...(!u1Backup.googleId ? { $unset: { googleId: 1 } } : {}),
      ...(!u1Backup.phone ? { $unset: { phone: 1 } } : {})
    }
  );

  // Step C: Set User 1 (currently temp) credentials to User 2's original
  console.log(`  - Setting temporary placeholder identity to ${email2}...`);
  await User.updateOne(
    { _id: u1._id },
    {
      $set: {
        email: u2.email,
        password: u2.password,
        barkUrl: u2.barkUrl,
        ...(u2.googleId ? { googleId: u2.googleId } : {}),
        ...(u2.phone ? { phone: u2.phone } : {})
      },
      ...(!u2.googleId ? { $unset: { googleId: 1 } } : {}),
      ...(!u2.phone ? { $unset: { phone: 1 } } : {})
    }
  );

  console.log(`  - Success: Swapped login profiles on documents [${u1._id}] ⇄ [${u2._id}]`);
}

async function convertResumesToObjectIdLinks() {
  console.log('\n📄 Converting all resumes to use ObjectId user links...');
  const resumes = await Resume.find({});
  console.log(`  Found ${resumes.length} resumes to process.`);

  let updatedCount = 0;

  for (const resume of resumes) {
    const origUser = resume.user;
    if (!origUser) continue;

    // Check if it's already an ObjectId. If it is, skip
    if (mongoose.Types.ObjectId.isValid(origUser) && origUser.length === 24) {
      console.log(`  Resume [${resume.slug}] already has ObjectId link: ${origUser}`);
      continue;
    }

    // Find the user document that currently has this email address
    const userDoc = await User.findOne({ email: { $regex: new RegExp(`^${origUser}$`, 'i') } });
    if (!userDoc) {
      console.warn(`  ⚠️ User document not found for email string: ${origUser}. Skipping resume [${resume.slug}]...`);
      continue;
    }

    // Determine the user's current email (after the swap)
    const currentEmail = userDoc.email;

    // Update slug to reflect current email prefix
    let newSlug = resume.slug;
    if (resume.slug.startsWith(origUser)) {
      newSlug = resume.slug.replace(origUser, currentEmail);
    }

    // Update Resume document with the owner's User _id (ObjectId) and new slug
    await Resume.updateOne(
      { _id: resume._id },
      { 
        $set: { 
          user: userDoc._id,
          slug: newSlug
        } 
      }
    );

    console.log(`  Updated Resume [${resume.title}]:`);
    console.log(`    - Old User: "${origUser}" ➔ New User ObjectId: "${userDoc._id}" (${currentEmail})`);
    console.log(`    - Old Slug: "${resume.slug}" ➔ New Slug: "${newSlug}"`);
    updatedCount++;
  }

  console.log(`✅ Refactoring complete. Converted and updated ${updatedCount} resumes.`);
}

performSwapAndRefactor();
