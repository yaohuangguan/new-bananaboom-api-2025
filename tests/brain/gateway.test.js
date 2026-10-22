import { jest } from '@jest/globals';
import gateway from '../../cloudflare/orion-api-gateway/src/index.js';
afterEach(() => jest.restoreAllMocks());
test('Phase 3: Vault mutations use existing expensive gateway limiter; reads and prefix collisions retain their buckets', async () => {
  const env = {
    ORIGIN_URL: 'https://synthetic-origin.invalid',
    GENERAL_LIMITER: { limit: jest.fn(async () => ({ success: true })) },
    WRITE_LIMITER: { limit: jest.fn(async () => ({ success: true })) },
    EXPENSIVE_LIMITER: { limit: jest.fn(async () => ({ success: true })) },
    AUTH_LIMITER: { limit: jest.fn(async () => ({ success: true })) }
  };
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response('synthetic', { status: 200 }));
  for (const route of [
    '/imports',
    '/imports/654321000000000000000001/commit',
    '/exports',
    '/restore/preview',
    '/restore/commit',
    '/legacy/preview'
  ]) {
    const response = await gateway.fetch(
      new Request('https://synthetic-edge.invalid/api/brain' + route, { method: 'POST', body: 'synthetic body' }),
      env
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
  expect(env.EXPENSIVE_LIMITER.limit).toHaveBeenCalledTimes(6);
  await gateway.fetch(new Request('https://synthetic-edge.invalid/api/brain/exports'), env);
  expect(env.GENERAL_LIMITER.limit).toHaveBeenCalledTimes(1);
  await gateway.fetch(
    new Request('https://synthetic-edge.invalid/api/brainish/exports', { method: 'POST', body: '{}' }),
    env
  );
  expect(env.WRITE_LIMITER.limit).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(8);
});
