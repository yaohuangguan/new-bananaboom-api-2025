import { ObjectId } from 'mongodb';

const VALID_ID = /^[a-f0-9]{24}$/i;
const DEFAULT_AVATAR = 'https://cdn3.iconfinder.com/data/icons/vector-icons-6/96/256-512.png';
const PROFILE_PROJECTION = {
  _id:1,googleId:1,displayName:1,email:1,phone:1,
  isProfileCompleted:1,date:1,photoURL:1,height:1,fitnessGoal:1,
  aiServices:1,role:1,extraPermissions:1,barkUrl:1,timezone:1,__v:1
};

export async function getOwnerProfile(db, liveUser) {
  const id = liveUser?.id;
  if (typeof id !== 'string' || !VALID_ID.test(id)) return null;
  const user = await db.collection('users').findOne(
    {_id: new ObjectId(id)}, {projection:PROFILE_PROJECTION}
  );
  if (!user) return null;
  const role = user.role || 'user';
  // These are the Mongoose User schema's optional defaults. VIP is now only
  // a read-only alias for the live role, never a separate permission bit.
  // Whitelist the public-to-account fields even after the Mongo projection:
  // never spread arbitrary DB properties such as password or reset tokens.
  const result = {
    _id: user._id,
    ...Object.fromEntries(Object.entries(user).filter(([key]) =>
      Object.hasOwn(PROFILE_PROJECTION, key))),
    displayName: user.displayName,
    isProfileCompleted: user.isProfileCompleted ?? false,
    photoURL: user.photoURL || DEFAULT_AVATAR,
    fitnessGoal: user.fitnessGoal || 'maintain',
    role,
    extraPermissions: Array.isArray(user.extraPermissions) ? user.extraPermissions : [],
    timezone: user.timezone || 'Asia/Shanghai',
    vip: role === 'super_admin',
    id: String(user._id),
    permissions: Array.isArray(liveUser.permissions) ? liveUser.permissions : []
  };
  // Old Cloud Run replied with an obsolete hard-coded private_token.
  // Never send a shared admin secret in new authenticated profile responses.
  delete result.private_token;
  return JSON.parse(JSON.stringify(result));
}

export async function getOwnerAiStatus(db, liveUser) {
  const id = liveUser?.id;
  if (typeof id !== 'string' || !VALID_ID.test(id)) return null;
  const user = await db.collection('users').findOne(
    {_id:new ObjectId(id)}, {projection:{aiServices:1}}
  );
  if (!user) return null;
  return {
    success:true,
    data: JSON.parse(JSON.stringify(user.aiServices || {}))
  };
}
