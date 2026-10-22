import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('Phase 3: actual application boots and Vault core flows work without AI configuration', async () => {
  const script = fileURLToPath(new URL('./no-ai-runtime.mjs', import.meta.url));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, NODE_ENV: 'test', MONGO_URI: globalThis.__brainTestUri },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('NO_AI_RUNTIME_TIMEOUT: ' + stdout + stderr)); }, 30000);
    child.stdout.on('data', b => { stdout += b; });
    child.stderr.on('data', b => { stderr += b; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
  if (result.status !== 0) throw new Error(JSON.stringify(result));
  expect(result.stdout).toContain('PASS NO_AI_KEY');
}, 35000);
