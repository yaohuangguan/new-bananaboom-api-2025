import { ObjectId } from 'mongodb';

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const DEFAULT_PHOTO = 'https://cdn3.iconfinder.com/data/icons/vector-icons-6/96/256-512.png';

function asId(value) {
  if (!value || typeof value.toString !== 'function') return null;
  const id = String(value);
  return OBJECT_ID.test(id) ? id : null;
}

function publicUser(user) {
  const result = {
    _id: user._id,
    displayName: user.displayName,
    photoURL: user.photoURL || DEFAULT_PHOTO,
    role: user.role || 'user'
  };
  result.vip = result.role === 'super_admin';
  result.id = String(user._id);
  return result;
}

export function normalizePublicComments(comments, users = []) {
  const map = new Map(users.map((user) => [String(user._id), publicUser(user)]));
  return comments.map((comment) => {
    const user = map.get(asId(comment.user));
    const legacyId = String(comment._userid || 'legacy_id');
    const finalUser = user || {
      _id: legacyId,
      displayName: typeof comment.user === 'string' ? comment.user : '匿名用户',
      photoURL: comment.photoURL || DEFAULT_PHOTO,
      vip: false
    };
    const text = comment.content || comment.comment || '';
    const replies = (comment.reply || []).map((reply) => {
      const replyUser = map.get(asId(reply.user)) || {
        displayName: typeof reply.user === 'string' ? reply.user : '匿名用户',
        photoURL: reply.photoURL || ''
      };
      return { ...reply, user: replyUser, date: reply.date };
    });
    return {
      _id: comment._id,
      id: String(comment._id),
      _postid: comment.post || comment._postid,
      _userid: user ? String(user._id) : legacyId,
      user: finalUser,
      photoURL: finalUser.photoURL || comment.photoURL || '',
      comment: text,
      content: text,
      date: comment.date,
      reply: replies,
      __v: comment.__v || 0
    };
  });
}

export async function getPublicComments(db, rawPostId, {reply = false} = {}) {
  if (!OBJECT_ID.test(rawPostId || '')) return null;
  const id = new ObjectId(rawPostId);
  const comments = reply
    ? [await db.collection('comments').findOne({_id:id})].filter(Boolean)
    : await db.collection('comments')
      .find({$or:[{post:id},{_postid:id}]})
      .sort({date:-1}).toArray();
  if (reply && comments.length === 0) return null;
  const ids = new Set();
  for (const comment of comments) {
    if (asId(comment.user)) ids.add(String(comment.user));
    for (const r of comment.reply || []) if (asId(r.user)) ids.add(String(r.user));
  }
  const users = ids.size
    ? await db.collection('users')
      .find({_id:{$in:[...ids].map((value)=>new ObjectId(value))}}, {
        projection:{_id:1,displayName:1,photoURL:1,role:1}
      }).toArray()
    : [];
  return JSON.parse(JSON.stringify(normalizePublicComments(comments,users)));
}
