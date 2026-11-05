const POST_DETAIL_PATH = /^\/api\/posts\/[a-f\d]{24}$/i;
const SAFE_AUTHOR_FIELDS = ['_id', 'displayName', 'photoURL'];

export function shouldRedactPublicPost(request) {
  if (request.method !== 'GET') return false;
  const path = new URL(request.url).pathname;
  return path === '/api/posts' || POST_DETAIL_PATH.test(path);
}

export function redactPostAuthor(post) {
  if (!post || typeof post !== 'object' || Array.isArray(post)) return post;
  if (!post.user || typeof post.user !== 'object' || Array.isArray(post.user)) return post;
  const user = Object.fromEntries(
    SAFE_AUTHOR_FIELDS.filter((key) => Object.hasOwn(post.user, key))
      .map((key) => [key, post.user[key]])
  );
  return { ...post, user };
}

export function redactPublicPostPayload(value) {
  if (Array.isArray(value)) return value.map(redactPostAuthor);
  if (value && typeof value === 'object' && Array.isArray(value.data)) {
    return { ...value, data: value.data.map(redactPostAuthor) };
  }
  return redactPostAuthor(value);
}

export async function redactPublicPostResponse(request, response) {
  if (!shouldRedactPublicPost(request) || !response.ok) return response;
  // Never leak unsanitized output if the upstream unexpectedly returned a
  // non-JSON success response.
  if (!(response.headers.get('content-type') || '').includes('application/json')) {
    return new Response(JSON.stringify({ error: 'Invalid post response' }), {
      status: 502, headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid post response' }), {
      status: 502, headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }
  const headers = new Headers(response.headers);
  for (const name of ['content-length', 'content-encoding', 'etag', 'content-md5']) headers.delete(name);
  headers.set('cache-control', 'no-store');
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(redactPublicPostPayload(payload)), {
    status: response.status, statusText: response.statusText, headers
  });
}
