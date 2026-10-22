#!/usr/bin/env node
// Standalone: Node 22+ and Python 3 stdlib only. No npm install or Orion service.
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encrypted, unseal } from './crypto.mjs';
const [command, input, ...args] = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
try {
  if (!['verify', 'read', 'restore', 'decrypt'].includes(command) || !input)
    throw new Error(
      'USAGE: node brain-vault.mjs verify|read|restore|decrypt ARCHIVE --output NEW_PATH --passphrase-file FILE'
    );
  if ((await fs.stat(input)).size > 128 * 1024 * 1024) throw new Error('ARCHIVE_TOO_LARGE');
  let bytes = await fs.readFile(input);
  if (encrypted(bytes)) {
    const keyFile = option('--passphrase-file');
    let passphrase;
    if (keyFile) {
      const stat = await fs.stat(keyFile);
      if (process.platform !== 'win32' && stat.mode & 0o077) throw new Error('PASSPHRASE_FILE_MUST_BE_MODE_600');
      passphrase = (await fs.readFile(keyFile, 'utf8')).replace(/\r?\n$/, '');
    } else if (args.includes('--passphrase-stdin')) passphrase = (await fs.readFile(0, 'utf8')).replace(/\r?\n$/, '');
    else throw new Error('PASSPHRASE_FILE_OR_STDIN_REQUIRED');
    bytes = await unseal(bytes, passphrase);
    passphrase = undefined;
  }
  if (command === 'decrypt') {
    const out = option('--output');
    if (!out) throw new Error('OUTPUT_REQUIRED');
    await fs.writeFile(out, bytes, { flag: 'wx', mode: 0o600 });
    console.log('Decrypted authenticated archive. Run verify before use.');
  } else {
    const out = option('--output');
    if (command !== 'verify' && !out) throw new Error('OUTPUT_NEW_DIRECTORY_REQUIRED');
    const script = fileURLToPath(new URL('./archive.py', import.meta.url));
    const result = spawnSync(
      option('--python') || (process.platform === 'win32' ? 'python' : 'python3'),
      [script, command, ...(out ? [out] : [])],
      { input: bytes, maxBuffer: 1024 * 1024, windowsHide: true }
    );
    if (result.error || result.status !== 0)
      throw new Error(result.error?.code || 'ARCHIVE_VALIDATION_OR_RESTORE_FAILED');
    process.stdout.write(result.stdout);
  }
} catch (e) {
  console.error(/^[A-Z0-9_ :|+.-]+$/i.test(e.message) ? e.message : 'VAULT_RECOVERY_FAILED');
  process.exitCode = 1;
}
