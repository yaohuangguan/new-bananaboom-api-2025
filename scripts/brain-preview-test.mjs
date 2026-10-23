/* global document, innerWidth, getComputedStyle */
// Local cross-repository preview acceptance, using synthetic auth/data only.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { brainRouter, finishBrainRouter } from '../routes/brain.js';
import { BrainMemory, BrainSource } from '../models/brain.js';
import { verifyArchive, exportArchive } from '../services/brain/archive.js';
import { unseal, seal } from '../services/brain/crypto.mjs';
import User from '../models/User.js';
import { brainSyncRouter } from '../routes/brainSync.js';
import { vaultOAuthRouter } from '../services/brain/oauth.js';
import { importKnowledge } from '../services/brain/knowledge.js';
const frontend = process.env.ORION_FRONTEND_DIR || fileURLToPath(new URL('../../orion-frontend/', import.meta.url));
const frontendRequire = createRequire(path.join(frontend, 'package.json'));
const { createServer } = await import(pathToFileURL(frontendRequire.resolve('vite')).href);
const puppeteer = (await import(pathToFileURL(frontendRequire.resolve('puppeteer')).href)).default;
for (const name of Object.keys(process.env))
  if (/^(GEMINI|OPENAI|ANTHROPIC|CLAUDE|GOOGLE_API_KEY)/.test(name)) delete process.env[name];
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orion-vault-preview-'));
process.env.NODE_ENV = 'test';
process.env.BRAIN_STORAGE_ROOT = path.join(directory, 'private-objects');
process.env.VITE_API_URL = '/api';
let mongo, apiServer, vite, browser, page;
try {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(mongo.getUri('orion_vault_local_preview'));
  await User.create({ _id: '654321000000000000000001', displayName: 'Synthetic owner', email: 'synthetic@example.invalid', extraPermissions: ['BRAIN:USE'] });
  const app = express();
  app.use((req, _res, next) => {
    if (req.headers.cookie?.includes('brain_preview_session=synthetic-only'))
      req.user = { id: '654321000000000000000001', permissions: ['BRAIN:USE'] };
    req.authSource = 'cookie';
    next();
  });
  app.get('/api/external/{*path}', (_req, res) => res.json({ list: [] }));
  app.use('/api/brain/sync', brainSyncRouter());
  app.use('/api/brain', finishBrainRouter(brainRouter));
  apiServer = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const apiBase = 'http://127.0.0.1:' + apiServer.address().port;
  process.env.BRAIN_CONNECT_PUBLIC_URL = apiBase;
  app.use(vaultOAuthRouter());
  // Tailwind's automatic source scan must run from the actual frontend root.
  process.chdir(frontend);
  vite = await createServer({
    root: frontend,
    mode: 'test',
    server: {
      host: '127.0.0.1',
      port: 0,
      open: false,
      proxy: { '/api': { target: 'http://127.0.0.1:' + apiServer.address().port, changeOrigin: false } }
    }
  });
  await vite.listen();
  const origin = 'http://127.0.0.1:' + vite.httpServer.address().port;
  process.env.BRAIN_ALLOWED_ORIGINS = origin;
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH, headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage();
  const errors = [];
  await page.setViewport({ width: 1440, height: 1050 });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setCookie({ name: 'brain_preview_session', value: 'synthetic-only', url: origin, httpOnly: true });
  await page.goto(origin + '/tests/brain/index.html', { waitUntil: 'networkidle0' });
  await page.waitForSelector('.captains-cabin');
  const minimizeNews = await page.$('button .fa-compress-alt');
  if (minimizeNews) await minimizeNews.click();
  const click = async text => {
    if (['Sources','Backup & Restore'].includes(text)) await page.click('.vault-tools-menu > summary');
    await page.locator('button ::-p-text(' + text + ')').click();
  };
  assert.ok(await page.$('.captains-cabin .memory-vault'));
  const cabinStyle = await page.$eval('.memory-vault', (el) => ({
    surface: getComputedStyle(el.querySelector('.vault-head')).backgroundColor,
    accent: getComputedStyle(el).getPropertyValue('--vault-accent').trim()
  }));
  assert.equal(cabinStyle.accent, '#e11d48');
  const shellStyle = await page.$eval('.captains-cabin', el => ({ background: getComputedStyle(el).backgroundImage, paddingTop: getComputedStyle(el).paddingTop }));
  assert.notEqual(shellStyle.background, 'none'); assert.equal(shellStyle.paddingTop, '96px');
  assert.ok(cabinStyle.surface.startsWith('rgba(255, 255, 255'));
  await click('New memory');
  await page.type('[aria-label="Statement"]', 'E2E 中文 memory with real local API');
  await click('Save revision');
  await page.waitForFunction(() => document.body.textContent.includes('Saved with a new revision'));
  assert.equal(await BrainMemory.countDocuments(), 1);
  await click('Sources');
  const source = path.join(directory, 'manual-source.md');
  await fs.writeFile(source, 'Imported E2E 原始证据');
  await page.select('.vault-editor select', 'manual');
  await (await page.$('input[type="file"]')).uploadFile(source);
  await click('Preview import');
  await page.waitForFunction(() => document.body.textContent.includes('Current job'));
  await click('Confirm additive import');
  await page.waitForFunction(() => document.body.textContent.includes('complete'));
  assert.equal(await BrainSource.countDocuments(), 2);
  assert.equal(await BrainMemory.countDocuments(), 2);
  await click('Backup & Restore');
  await page.waitForSelector('[aria-label="Backup passphrase"]');
  await page.type('[aria-label="Backup passphrase"]', 'local preview synthetic key');
  const createdResponse = page.waitForResponse((r) => r.url().endsWith('/exports') && r.request().method() === 'POST');
  await click('Create & verify backup');
  const created = await createdResponse;
  assert.equal(created.status(), 201);
  const job = await created.json();
  const response = await fetch(
    'http://127.0.0.1:' + apiServer.address().port + '/api/brain/exports/' + job._id + '/download',
    { headers: { cookie: 'brain_preview_session=synthetic-only' } }
  );
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  const archive = await verifyArchive(await unseal(bytes, 'local preview synthetic key'));
  assert.equal(archive.manifest.counts.memories, 2);
  const fixture = path.join(directory, 'preview.orion');
  await fs.writeFile(fixture, bytes);
  await page.waitForFunction(() => document.querySelector('[aria-label="Backup passphrase"]').value === '');
  await (await page.$('[aria-label="Restore file"]')).uploadFile(fixture);
  await page.type('[aria-label="Restore passphrase"]', 'local preview synthetic key');
  await click('Verify & preview restore');
  await page.waitForFunction(() => document.body.textContent.includes('Archive coverage'));
  const committedResponse = page.waitForResponse((r) => r.url().endsWith('/restore/commit'));
  await click('Confirm additive restore');
  assert.equal((await committedResponse).status(), 200);
  assert.equal(await BrainMemory.countDocuments(), 2);
  // Synthetic categorized data exercises totals beyond the paginated first page.
  const knowledge = [['Instructions',5],['Identity',28],['Career',22],['Projects',12],['Preferences',35]]
    .map(([name,count],i) => '# '+(i+1)+'. '+name+'\n'+Array.from({length:count},(_,n) => '[2026-04-25] - Synthetic '+name.toLowerCase()+' knowledge '+(n+1)).join('\n')).join('\n');
  const imported = await importKnowledge('654321000000000000000001', Buffer.from(knowledge));
  assert.equal(imported.created, 102);
  await click('AI Sync');
  await page.waitForSelector('[aria-label="MCP URL"], [aria-label="ChatGPT MCP URL"]');
  await page.click('.knowledge-api-details > summary');
  await click('Create dedicated key');
  await page.waitForSelector('[aria-label="New connection key"]');
  const token = await page.$eval('[aria-label="New connection key"]', el => el.value);
  assert.equal(await page.evaluate(value => Object.values(localStorage).some(v => v.includes(value)), token), false);
  const packet = { requestId: 'preview-sync-roundtrip-001', statement: 'Synthetic preference saved from a connected AI', type: 'preference' };
  const endpoint = 'http://127.0.0.1:' + apiServer.address().port + '/api/brain/sync/v1/sync';
  const send = () => fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer '+token, 'Content-Type':'application/json' }, body: JSON.stringify(packet) });
  const synced = await send(); assert.equal(synced.status,200);
  const actual = await synced.json(); assert.ok(actual.memory.sourceAnchors.length);
  const repeated = await send(); assert.equal(repeated.status,200);
  assert.equal((await repeated.json()).memory._id, actual.memory._id);
  assert.equal(await BrainMemory.countDocuments(),105);
  await click('Saved, close'); assert.equal(await page.$('[aria-label="New connection key"]'),null);
  await click('Refresh');
  await page.waitForFunction(() => document.querySelector('.knowledge-connection-list')?.textContent.includes('Last write:'));
  page.once('dialog', dialog => dialog.accept());
  await click('Revoke');
  await page.waitForFunction(() => document.querySelector('.knowledge-connection-list')?.textContent.includes('Revoked'));
  assert.equal((await send()).status,401);
  // A real PKCE request crosses the browser consent screen without losing its nonce on sign-in.
  const registered = await fetch(apiBase + '/register', { method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ client_name:'Synthetic Claude', redirect_uris:['https://callback.example.invalid/complete'], token_endpoint_auth_method:'none', grant_types:['authorization_code','refresh_token'], response_types:['code'] }) });
  assert.equal(registered.status,201);
  const client = await registered.json(), verifier = randomBytes(32).toString('base64url');
  const authQuery = new URLSearchParams({ client_id:client.client_id, redirect_uri:client.redirect_uris[0], response_type:'code',
    code_challenge:createHash('sha256').update(verifier).digest('base64url'), code_challenge_method:'S256',
    scope:'memory:read memory:write', state:'preview-state', resource:apiBase+'/api/brain/sync/mcp' });
  const pending = await fetch(apiBase+'/authorize?'+authQuery, {redirect:'manual'});
  assert.equal(pending.status,302);
  const nonce = new URL(pending.headers.get('location')).searchParams.get('request');
  let callback = null;
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (req.isNavigationRequest() && new URL(req.url()).origin === 'https://callback.example.invalid' && new URL(req.url()).pathname === '/complete') { callback = new URL(req.url()); return req.respond({status:200,contentType:'text/html',body:'<p>Authorized synthetic callback</p>'}); }
    return req.continue();
  });
  await page.goto(origin+'/tests/brain/index.html?consent&signedOut&request='+encodeURIComponent(nonce), {waitUntil:'networkidle0'});
  await page.locator('button ::-p-text(Sign in to Orion)').click();
  await page.waitForSelector('.knowledge-consent-account');
  assert.ok((await page.content()).includes('synthetic@example.invalid'));
  await page.click('.knowledge-consent-permissions input[type=checkbox]');
  const decision = page.waitForResponse(r=>r.url().endsWith('/connections/authorize') && r.request().method()==='POST');
  await page.locator('button ::-p-text(Allow connection)').click();
  assert.equal((await decision).status(),200);
  await page.waitForFunction(()=>document.body.textContent.includes('Authorized synthetic callback'));
  assert.equal(callback.searchParams.get('state'),'preview-state');
  const issuerMetadata = await (await fetch(apiBase+'/.well-known/oauth-authorization-server')).json();
  assert.equal(callback.searchParams.get('iss'),issuerMetadata.issuer);
  const exchanged = await fetch(apiBase+'/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,code:callback.searchParams.get('code'),
      code_verifier:verifier,redirect_uri:client.redirect_uris[0],resource:apiBase+'/api/brain/sync/mcp'})});
  assert.equal(exchanged.status,200);
  assert.equal((await exchanged.json()).scope,'memory:read');
  const snapshot = await exportArchive('654321000000000000000001');
  const keyFile = path.join(directory,'synthetic-passphrase.txt'), synchronizedBackup = path.join(directory,'synchronized.orion');
  await fs.writeFile(keyFile,'offline synthetic sync recovery key',{mode:0o600});
  await fs.writeFile(synchronizedBackup,await seal(snapshot.bytes,'offline synthetic sync recovery key'));
  const offlineOutput = path.join(directory,'offline-readable');
  const cli = spawnSync(process.execPath,[fileURLToPath(new URL('../tools/brain-vault/brain-vault.mjs',import.meta.url)),
    'read',synchronizedBackup,'--passphrase-file',keyFile,'--output',offlineOutput],{encoding:'utf8',timeout:30000});
  assert.equal(cli.status,0,cli.stderr);
  const readable = await fs.readFile(path.join(offlineOutput,'memories-readable.txt'),'utf8');
  assert.ok(readable.includes(packet.statement));
  assert.ok(!readable.includes(token));
  assert.equal((await verifyArchive(snapshot.bytes)).manifest.counts.memories,105);
  await page.goto(origin+'/tests/brain/index.html',{waitUntil:'networkidle0'});
  const news = await page.$('button .fa-compress-alt');
  if (news) await news.click();
  await click('Overview');
  await page.waitForFunction(() => document.querySelector('.knowledge-you strong')?.textContent === '105');
  assert.equal(await page.$eval('[data-topic=preference] strong',el=>el.textContent),'36');
  assert.deepEqual(errors, []);
  const evidence = process.env.BRAIN_EVIDENCE_OUTPUT;
  if (evidence) {
    await fs.mkdir(evidence, { recursive: true });
    await new Promise(resolve => setTimeout(resolve, 700));
    await page.screenshot({ path: path.join(evidence, 'vault-preview-desktop.png'), fullPage: true });
    await click('Overview');
    await page.waitForFunction(() => document.querySelector('.memory-vault nav button[aria-current=page]')?.textContent.includes('Overview'));
    await new Promise(resolve => setTimeout(resolve, 700));
    await page.screenshot({ path: path.join(evidence, 'vault-cabin-overview.png'), fullPage: true });
    await page.setViewport({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await new Promise(resolve => setTimeout(resolve, 700));
    await page.screenshot({ path: path.join(evidence, 'vault-preview-mobile.png'), fullPage: true });
    await fs.writeFile(
      path.join(evidence, 'preview-result.json'),
      JSON.stringify(
        {
          passed: true,
          nodeVersion: process.version,
          mongoVersion: (await mongoose.connection.db.admin().command({ buildInfo: 1 })).version,
          syntheticAuth: true,
          modelKeysConfigured: false,
          cabinStyle,
          database: 'temporary Mongo replica set',
          frontend: 'real Vite/React',
          api: 'real Express/Mongoose',
          workflow: [
            'create',
            'import preview',
            'import commit',
            'encrypted export',
            'download/decrypt/verify',
            'restore preview',
            'idempotent restore commit',
            '102 synthetic categorized records aggregated beyond first page',
            'browser creates scoped connection key without localStorage',
            'real machine sync with source and idempotent retry',
            'browser observes last write and revokes connection',
            'revoked key rejected by real API',
            'real PKCE browser consent preserves request through sign-in and grants read-only scope',
            'encrypted 105-record archive including synced facts independently read by standalone offline CLI'
          ],
          counts: archive.manifest.counts,
          finalMemories: await BrainMemory.countDocuments(),
          allKnowledgeSynthetic: true,
          offlineRecovery: 'standalone CLI read verified all 105 records including synced knowledge',
          mobile: '390x844 no overflow'
        },
        null,
        2
      )
    );
  }
  console.log(
    'PASS local full-stack preview: real React -> Vite proxy -> Express/owner guard -> MongoDB/private bytes; create/import/encrypted export/decrypt/verify/restore; mobile layout.'
  );
} catch (error) {
  if (page && process.env.BRAIN_EVIDENCE_OUTPUT) {
    await fs.mkdir(process.env.BRAIN_EVIDENCE_OUTPUT, { recursive: true });
    await fs.writeFile(path.join(process.env.BRAIN_EVIDENCE_OUTPUT,'failure.html'), await page.content());
    await page.screenshot({ path: path.join(process.env.BRAIN_EVIDENCE_OUTPUT,'failure.png'), fullPage: true });
  }
  throw error;
} finally {
  await browser?.close();
  await vite?.close();
  if (apiServer) await new Promise((resolve) => apiServer.close(resolve));
  await mongoose.disconnect();
  await mongo?.stop();
  // Remove only this mkdtemp-owned test directory after all services stop.
  await fs.rm(directory, { recursive: true, force: true });
}
