import express from 'express';
import request from 'supertest';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import User from '../../models/User.js';
import { BrainMemory, BrainRevision, BrainSource, BrainDocument } from '../../models/brain.js';
import { BrainConnection, BrainCredential } from '../../models/brainSync.js';
import { brainRouter, finishBrainRouter } from '../../routes/brain.js';
import { brainSyncRouter } from '../../routes/brainSync.js';
import { vaultOAuthRouter } from '../../services/brain/oauth.js';
import { getPrivate } from '../../services/brain/storage.js';
const owner = '654321000000000000000001', other = '654321000000000000000002';
let app, server, base;
beforeAll(async () => {
  app = express();
  app.use((req, _res, next) => {
    if (req.get('test-user')) req.user = { id: req.get('test-user'), permissions: ['BRAIN:USE'] };
    req.authSource = 'header'; next();
  });
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = 'http://127.0.0.1:' + server.address().port;
  process.env.BRAIN_CONNECT_PUBLIC_URL = base;
  app.use(vaultOAuthRouter());
  app.use('/api/brain/sync', brainSyncRouter());
  app.use('/api/brain', finishBrainRouter(brainRouter));
});
beforeEach(async () => {
  await User.create([{ _id: owner, displayName: 'Synthetic owner', email: 'owner@example.invalid', extraPermissions: ['BRAIN:USE'] },
    { _id: other, displayName: 'Synthetic other', email: 'other@example.invalid', extraPermissions: ['BRAIN:USE'] }]);
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); delete process.env.BRAIN_CONNECT_PUBLIC_URL; });
async function key(who = owner, scopes = ['memory:read', 'memory:write']) {
  const r = await request(app).post('/api/brain/connections').set('test-user', who).send({ label: 'Synthetic GPT', provider: 'chatgpt', scopes });
  expect(r.status).toBe(201);
  return r.body;
}
const auth = token => ({ Authorization: 'Bearer ' + token });
test('API keys are hashed, owner-scoped, least-privilege, expiring and immediately revocable', async () => {
  expect((await request(app).post('/api/brain/sync/v1/search').send({})).status).toBe(401);
  expect((await request(app).post('/api/brain/sync/v1/search?token=guess').send({})).status).toBe(401);
  const read = await key(owner, ['memory:read']), foreign = await key(other);
  expect((await BrainCredential.findOne().lean()).hash).not.toBe(read.token);
  expect(JSON.stringify((await request(app).get('/api/brain/connections').set('test-user', owner)).body)).not.toContain(read.token);
  expect((await request(app).post('/api/brain/sync/v1/sync').set(auth(read.token)).send({ requestId: 'read-only-test', statement: 'denied' })).status).toBe(403);
  expect((await request(app).delete('/api/brain/connections/' + read.connection._id).set('test-user', other)).status).toBe(404);
  expect((await request(app).post('/api/brain/sync/v1/search').set(auth(foreign.token)).send({})).body.items).toEqual([]);
  expect((await request(app).delete('/api/brain/connections/' + read.connection._id).set('test-user', owner)).status).toBe(200);
  expect((await request(app).post('/api/brain/sync/v1/search').set(auth(read.token)).send({})).status).toBe(401);
  await BrainConnection.updateOne({ _id: foreign.connection._id }, { $set: { expiresAt: new Date(0) } });
  expect((await request(app).post('/api/brain/sync/v1/search').set(auth(foreign.token)).send({})).status).toBe(401);
});
test('sync retries are idempotent and corrections retain evidence with optimistic concurrency', async () => {
  const own = await key(), foreign = await key(other);
  const packet = { requestId: 'stable-request-0001', statement: 'Synthetic preference for clear interfaces', type: 'preference', tags: ['design'], sensitivity: 'restricted' };
  const calls = await Promise.all([1,2].map(() => request(app).post('/api/brain/sync/v1/sync').set(auth(own.token)).send(packet)));
  expect(calls.map(r => r.status)).toEqual([200,200]);
  const m = calls[0].body.memory;
  expect(calls[1].body.memory._id).toBe(m._id);
  expect(await BrainMemory.countDocuments()).toBe(1);
  expect(await BrainRevision.countDocuments()).toBe(1);
  const source = await BrainSource.findById(m.sourceId).lean();
  expect(JSON.parse((await getPrivate(owner, source.privateObjectKey)).toString()).statement).toBe(packet.statement);
  expect((await request(app).post('/api/brain/sync/v1/sync').set(auth(own.token)).send({ ...packet, statement: 'mismatched retry' })).status).toBe(409);
  expect((await request(app).get('/api/brain/sync/v1/memories/' + m._id).set(auth(foreign.token))).status).toBe(404);
  expect((await request(app).post('/api/brain/sync/v1/sync').set(auth(own.token)).send({ ...packet, requestId: 'update-missing-version', memoryId: m._id })).status).toBe(400);
  const update = await request(app).post('/api/brain/sync/v1/sync').set(auth(own.token)).send({
    requestId: 'updated-request-0002', statement: 'Corrected synthetic preference', memoryId: m._id, expectedRevision: 1
  });
  expect(update.status).toBe(200);
  expect(update.body.memory.revision).toBe(2);
  expect(update.body.memory.type).toBe('preference');
  expect(update.body.memory.tags).toEqual(['design']);
  expect(update.body.memory.sensitivity).toBe('restricted');
  expect(update.body.memory.sourceId).not.toBe(m.sourceId);
  expect(await BrainRevision.countDocuments()).toBe(2);
  expect(await BrainDocument.countDocuments()).toBe(2);
  expect((await request(app).post('/api/brain/sync/v1/search').set(auth(own.token)).send({ query: 'corrected' })).body.items).toHaveLength(1);
  expect((await request(app).post('/api/brain/sync/v1/sync').set(auth(own.token)).send({ ...packet, requestId: 'owner-forgery-test', ownerId: other })).status).toBe(400);
  await User.updateOne({ _id: owner }, { $set: { extraPermissions: [] } });
  expect((await request(app).post('/api/brain/sync/v1/search').set(auth(own.token)).send({})).status).toBe(403);
});
async function begin(scopes = 'memory:read memory:write') {
  const registered = await request(app).post('/register').send({
    client_name: 'Synthetic Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code','refresh_token'], response_types: ['code']
  });
  expect(registered.status).toBe(201);
  const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
  const params = { client_id: registered.body.client_id, response_type: 'code', redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: challenge, code_challenge_method: 'S256', scope: scopes, state: 'synthetic-state', resource: base + '/api/brain/sync/mcp' };
  const authorize = await request(app).get('/authorize').query(params);
  expect(authorize.status).toBe(302);
  const pending = new URL(authorize.headers.location).searchParams.get('request');
  return { client: registered.body.client_id, verifier, pending, params };
}
async function grant(flow, scopes = ['memory:read','memory:write']) {
  const approved = await request(app).post('/api/brain/connections/authorize').set('test-user', owner).send({ request: flow.pending, allow: true, scopes });
  expect(approved.status).toBe(200);
  const metadata = (await request(app).get('/.well-known/oauth-authorization-server')).body;
  const resource = (await request(app).get('/.well-known/oauth-protected-resource/api/brain/sync/mcp')).body;
  expect(resource.authorization_servers).toContain(metadata.issuer);
  expect(new URL(approved.body.redirectUrl).searchParams.get('iss')).toBe(metadata.issuer);
  return new URL(approved.body.redirectUrl).searchParams.get('code');
}
const exchange = (flow, code, verifier = flow.verifier) => request(app).post('/token').type('form').send({
  grant_type: 'authorization_code', client_id: flow.client, code, code_verifier: verifier,
  redirect_uri: flow.params.redirect_uri, resource: base + '/api/brain/sync/mcp'
});
test('OAuth rejects redirect forgery, enforces consent and PKCE, and prevents code replay', async () => {
  const invalid = await request(app).post('/register').send({ token_endpoint_auth_method: 'none', redirect_uris: ['http://evil.invalid/callback'] });
  expect(invalid.status).toBe(400);
  const flow = await begin();
  const forged = await request(app).get('/authorize').query({ ...flow.params, redirect_uri: 'https://evil.invalid/callback' });
  expect(forged.status).toBe(400);
  expect(forged.headers.location).toBeUndefined();
  const details = await request(app).get('/api/brain/sync/authorization/' + flow.pending);
  expect(details.body.redirectOrigin).toBe('https://claude.ai');
  expect((await request(app).post('/api/brain/connections/authorize').send({ request: flow.pending, allow: true })).status).toBe(401);
  const code = await grant(flow);
  expect((await exchange(flow, code, randomBytes(32).toString('base64url'))).status).toBe(400);
  const tokens = await exchange(flow, code);
  expect(tokens.status).toBe(200);
  expect((await exchange(flow, code)).status).toBe(400);
  expect((await request(app).post('/api/brain/sync/v1/search').set(auth(tokens.body.access_token)).send({})).status).toBe(401);
  const revoked = await request(app).post('/revoke').type('form').send({ client_id: flow.client, token: tokens.body.access_token });
  expect(revoked.status).toBe(200);
  expect((await request(app).post('/api/brain/sync/mcp').set(auth(tokens.body.access_token)).send({})).status).toBe(401);
});
test('real MCP client can discover, save and read knowledge; refresh rotation rejects reuse', async () => {
  const flow = await begin(), code = await grant(flow), result = await exchange(flow, code);
  expect(result.status).toBe(200);
  const client = new Client({ name: 'synthetic-claude-web', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/api/brain/sync/mcp'), { requestInit: { headers: auth(result.body.access_token) } }));
    const tools = await client.listTools();
    expect(tools.tools.map(t => t.name)).toContain('sync_knowledge');
    const saved = await client.callTool({ name: 'sync_knowledge', arguments: { requestId: 'mcp-write-test-001', statement: 'Synthetic MCP knowledge' } });
    expect(saved.isError).not.toBe(true);
    const row = JSON.parse(saved.content[0].text).memory;
    const read = await client.callTool({ name: 'read_knowledge', arguments: { id: row._id } });
    expect(JSON.parse(read.content[0].text).statement).toBe('Synthetic MCP knowledge');
  } finally { await client.close(); }
  const refresh = { grant_type: 'refresh_token', client_id: flow.client, refresh_token: result.body.refresh_token, resource: base + '/api/brain/sync/mcp' };
  const rotated = await request(app).post('/token').type('form').send(refresh);
  expect(rotated.status).toBe(200);
  expect(rotated.body.refresh_token).not.toBe(result.body.refresh_token);
  expect((await request(app).post('/token').type('form').send(refresh)).status).toBe(400);
});
test('read-only OAuth cannot expose write tools or escalate scope, and denial creates no connection', async () => {
  const denied = await begin();
  const refusal = await request(app).post('/api/brain/connections/authorize').set('test-user', owner).send({ request: denied.pending, allow: false });
  expect(new URL(refusal.body.redirectUrl).searchParams.get('error')).toBe('access_denied');
  expect(await BrainConnection.countDocuments()).toBe(0);
  const flow = await begin('memory:read'), code = await grant(flow, ['memory:read']), tokens = await exchange(flow, code);
  const client = new Client({ name: 'synthetic-readonly', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/api/brain/sync/mcp'), { requestInit: { headers: auth(tokens.body.access_token) } }));
    expect((await client.listTools()).tools.map(t => t.name)).not.toContain('sync_knowledge');
  } finally { await client.close(); }
  const escalated = await request(app).post('/token').type('form').send({ grant_type: 'refresh_token', client_id: flow.client,
    refresh_token: tokens.body.refresh_token, scope: 'memory:read memory:write' });
  expect(escalated.status).toBe(400);
});
