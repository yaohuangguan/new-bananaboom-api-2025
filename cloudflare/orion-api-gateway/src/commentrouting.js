// Policy selects only NEW operations. Every retry carries its persisted route.
export function commentWritePolicy(request, env, authenticatedCarrier) {
  const worker = env.COMMENT_WRITE_CANARY === '1' &&
    (env.COMMENT_WRITE_CUTOVER === '1' ||
      request.headers.get('x-orion-comment-write-canary') === '1') &&
    authenticatedCarrier && !request.headers.get('x-google-auth');
  return {version: 2, route: worker ? 'worker' : 'legacy'};
}

export function selectCommentWrite(request, env, search, authenticatedCarrier) {
  const route = request.headers.get('x-orion-comment-write-route');
  if (route === 'legacy') return {worker: false};
  if (route === null) {
    // Old clients cannot prove which backend handled an uncertain operation.
    // Their normal traffic stays legacy; do not upgrade old manual canaries.
    return env.COMMENT_WRITE_CANARY === '1' &&
      request.headers.get('x-orion-comment-write-canary') === '1'
      ? {status: 428} : {worker: false};
  }
  if (route !== 'worker') return {status: 428};
  // Disabling new-operation cutover does not move pending Worker operations.
  // The separate emergency gate stops them, without executing on legacy.
  if (env.COMMENT_WRITE_CANARY !== '1') return {status: 503};
  if (search || request.headers.get('x-google-auth') || !authenticatedCarrier) {
    return {status: 401};
  }
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(request.headers.get('idempotency-key') || '')) {
    return {status: 428};
  }
  return {worker: true};
}
