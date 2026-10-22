// Invoked only by the synthetic suite; imports the actual application without model keys.
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import request from 'supertest';
for (const name of Object.keys(process.env))
  if (/^(GEMINI|OPENAI|ANTHROPIC|CLAUDE|GOOGLE_API_KEY)/.test(name)) delete process.env[name];
const { default: app } = await import('../../index.js');
const { default: Role } = await import('../../models/Role.js');
const { default: permissionService } = await import('../../services/permissionService.js');
const { getAiClient } = await import('../../utils/aiProvider.js');
try {
  console.log('NO_AI_STEP connect');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('NO_AI_STEP connected');
  await Role.create({ name: 'user', permissions: ['BRAIN:USE'] });
  await permissionService.reload();
  console.log('NO_AI_STEP register');
  const registered = await request(app)
    .post('/api/users')
    .send({
      displayName: 'No AI synthetic user',
      email: 'no-ai@example.invalid',
      password: 'Synthetic12345',
      passwordConf: 'Synthetic12345'
    });
  assert.equal(registered.status, 201);
  const token = registered.body.token;
  const call = (method, route) => {
    const client = request(app);
    return client[method]('/api/brain' + route).set('x-auth-token', token);
  };
  console.log('NO_AI_STEP create');
  const created = await call('post', '/memories').send({
    statement: '断网和无模型 key 仍可保存检索',
    reviewStatus: 'confirmed'
  });
  assert.equal(created.status, 201);
  const search = await call('post', '/search').send({ kind: 'memories', query: '无模型' });
  assert.equal(search.status, 200);
  assert.equal(search.body.items.length, 1);
  console.log('NO_AI_STEP export');
  const backup = await call('post', '/exports').send({ passphrase: 'synthetic offline passphrase' });
  assert.equal(backup.status, 201);
  const download = await call('get', '/exports/' + backup.body._id + '/download');
  assert.equal(download.status, 200);
  console.log('NO_AI_STEP preview');
  const preview = await call('post', '/restore/preview')
    .field('passphrase', 'synthetic offline passphrase')
    .attach('file', download.body, 'synthetic.orion');
  assert.equal(preview.status, 201);
  console.log('NO_AI_STEP restore');
  const restored = await call('post', '/restore/commit').send({ jobId: preview.body._id });
  assert.equal(restored.status, 200);
  assert.throws(() => getAiClient('default'), { message: 'AI_PROVIDER_NOT_CONFIGURED' });
  console.log(
    'PASS NO_AI_KEY actual app import/auth/create/search/encrypted export/restore; AI calls fail only when invoked.'
  );
  await mongoose.disconnect();
  process.exit(0);
} catch {
  console.error('NO_AI_KEY_RUNTIME_FAILED');
  await mongoose.disconnect();
  process.exit(1);
}
