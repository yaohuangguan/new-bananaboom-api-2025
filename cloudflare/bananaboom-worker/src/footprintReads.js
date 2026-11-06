import { ObjectId } from 'mongodb';

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const MAX_FOOTPRINTS = 5000;

export function parseFootprintQuery(query = {}) {
  const keys = Object.keys(query);
  if (keys.some(key => key !== 'status') || keys.length > 1) {
    throw new TypeError('Unsupported footprint query');
  }
  if (query.status !== undefined && !['visited', 'planned'].includes(query.status)) {
    throw new TypeError('Invalid footprint status');
  }
  return { status: query.status };
}

function hydrateLegacyDefaults(doc) {
  return {
    ...doc,
    companions: doc.companions ?? [],
    images: doc.images ?? [],
    content: doc.content ?? '',
    rating: doc.rating ?? 5,
    mood: doc.mood ?? 'happy',
    status: doc.status ?? 'visited',
    isHighlight: doc.isHighlight ?? false,
    location: doc.location ? {
      country: '中国',
      coordinates: [],
      ...doc.location
    } : doc.location
  };
}

/**
 * A private, owner-scoped MongoDB read. No user ID or filter object is
 * accepted from callers, and no other person's footprint can be returned.
 */
export async function readOwnerFootprints(db, owner, rawQuery = {}) {
  const userId = String(owner?.id || '');
  if (!OBJECT_ID.test(userId)) throw new TypeError('Invalid footprint owner');
  const { status } = parseFootprintQuery(rawQuery);
  const query = { user: new ObjectId(userId) };
  if (status) query.status = status;
  const collection = db.collection('footprints');
  // Legacy returns full history. A future oversized dataset is deliberately
  // left on Cloud Run rather than truncating records or changing stats.
  const count = await collection.countDocuments(query);
  if (count > MAX_FOOTPRINTS) throw new RangeError('Footprint history exceeds Worker read limit');
  const rows = await collection.find(query)
    .sort({ visitDate: -1 })
    .limit(MAX_FOOTPRINTS + 1)
    .toArray();
  if (rows.length > MAX_FOOTPRINTS) throw new RangeError('Footprint history exceeds Worker read limit');
  const data = rows.map(hydrateLegacyDefaults);
  const visited = data.filter(record => record.status === 'visited');
  const uniqueLocation = (key) => [...new Set(visited
    .map(record => record.location?.[key])
    .filter(Boolean))];
  return JSON.parse(JSON.stringify({
    code: 200,
    stats: {
      totalCount: visited.length,
      countries: uniqueLocation('country'),
      provinces: uniqueLocation('province'),
      citiesCount: uniqueLocation('city').length
    },
    data
  }));
}
