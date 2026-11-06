import { ObjectId } from 'mongodb';

const VALID_ID = /^[a-f0-9]{24}$/i;
const ALLOWED_KEYS = new Set(['page', 'limit', 'type', 'keyword', 'isActive']);

function positiveInteger(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d{0,3}$/.test(value)) throw new TypeError('Invalid Todo pagination');
  const number = Number(value);
  if (number > maximum) throw new TypeError('Todo pagination exceeds supported range');
  return number;
}

/** Strictly bounded subset of the legacy Todo GET contract. */
export function parseTodoReadQuery(query = {}) {
  if (Object.keys(query).some(key => !ALLOWED_KEYS.has(key))) throw new TypeError('Unsupported Todo query');
  if (Object.values(query).some(value => Array.isArray(value) || typeof value === 'object')) {
    throw new TypeError('Invalid Todo query');
  }
  const page = positiveInteger(query.page, 1, 1000);
  const limit = positiveInteger(query.limit, 20, 100);
  const type = query.type;
  if (type !== undefined && !['wish', 'routine'].includes(type)) throw new TypeError('Invalid Todo type');
  const keyword = query.keyword;
  if (keyword !== undefined && (typeof keyword !== 'string' || keyword.length > 100 ||
      keyword.includes('\0'))) throw new TypeError('Invalid Todo keyword');
  if (query.isActive !== undefined && !['true', 'false'].includes(query.isActive)) {
    throw new TypeError('Invalid Todo active flag');
  }
  return {
    page, limit, type,
    keyword: keyword || undefined,
    isActive: query.isActive === undefined ? undefined : query.isActive === 'true'
  };
}

function normalizeTodo(todo, owner, notifyMap) {
  const defaults = {
    description: '', type: 'wish', recurrence: null, isNotified: false,
    status: 'todo', done: false, images: [], order: 0, isActive: true
  };
  const normalized = {
    ...defaults,
    ...todo,
    bark: {
      sound: 'minuet', level: 'active', icon: '', url: '', image: '', call: '',
      ...(todo.bark || {})
    },
    user: owner || null,
    notifyUsers: (todo.notifyUsers || []).map(id => notifyMap.get(String(id))).filter(Boolean)
  };
  return normalized;
}

/** Owner-only, or super_admin family scope, with fixed Mongo predicates. */
export async function listOwnerTodos(db, owner, rawQuery = {}) {
  if (!owner || !VALID_ID.test(String(owner.id || ''))) throw new TypeError('Invalid Todo identity');
  const { page, limit, type, keyword, isActive } = parseTodoReadQuery(rawQuery);
  const users = db.collection('users');
  let userFilter;
  if (owner.role === 'super_admin') {
    const family = await users.find({ role: 'super_admin' }, { projection: { _id: 1 } }).toArray();
    userFilter = { $in: family.map(user => user._id) };
  } else {
    userFilter = new ObjectId(owner.id);
  }
  const filter = { user: userFilter };
  if (type !== undefined) filter.type = type;
  if (isActive !== undefined) filter.isActive = isActive;
  if (keyword) {
    // Escape regex metacharacters; user text is a literal search, not an executable regex.
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { todo: { $regex: escaped, $options: 'i' } },
      { description: { $regex: escaped, $options: 'i' } }
    ];
  }
  const todos = db.collection('todos');
  const [rows, total] = await Promise.all([
    todos.find(filter).sort({ order: -1, createdAt: -1 })
      .skip((page - 1) * limit).limit(limit).toArray(),
    todos.countDocuments(filter)
  ]);
  const ids = new Set();
  for (const row of rows) {
    if (VALID_ID.test(String(row.user || ''))) ids.add(String(row.user));
    for (const id of row.notifyUsers || []) {
      if (VALID_ID.test(String(id))) ids.add(String(id));
    }
  }
  const related = ids.size ? await users.find({
    _id: { $in: [...ids].map(id => new ObjectId(id)) }
  }, { projection: { _id: 1, displayName: 1, photoURL: 1, email: 1 } }).toArray() : [];
  const userMap = new Map(related.map(user => [String(user._id), user]));
  const data = rows.map(row => {
    const id = String(row.user || '');
    const user = userMap.get(id);
    const selected = user
      ? { _id: user._id, displayName: user.displayName, photoURL: user.photoURL, email: user.email }
      : null;
    const notifications = new Map([...userMap].map(([key, value]) => [key, {
      _id: value._id, displayName: value.displayName, photoURL: value.photoURL
    }]));
    return normalizeTodo(row, selected, notifications);
  });
  return JSON.parse(JSON.stringify({
    data,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) }
  }));
}
