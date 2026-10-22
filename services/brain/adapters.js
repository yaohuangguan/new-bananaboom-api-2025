import { fail, sha } from './core.js';
import { readZip, safeName } from './zip.js';
export function safeJson(bytes) {
  if (bytes.length > 32 * 1024 * 1024) fail('JSON_TOO_LARGE', 413);
  let data; try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('INVALID_JSON'); }
  const stack = [[data, 0]]; let count = 0;
  while (stack.length) {
    const [item, depth] = stack.pop();
    if (++count > 500000 || depth > 64) fail('JSON_COMPLEXITY_EXCEEDED');
    if (item && typeof item === 'object') for (const [k, v] of Object.entries(item)) {
      if (['__proto__', 'constructor', 'prototype'].includes(k) || k.startsWith('$')) fail('UNSAFE_JSON_KEY');
      stack.push([v, depth + 1]);
    }
  }
  return data;
}
const textContent = value => typeof value === 'string' ? value : '';
function references(value, out = new Set(), key = '') {
  if (typeof value === 'string' && ['asset_pointer', 'file_id', 'file_name', 'fileName', 'filename', 'image'].includes(key)) out.add(value);
  else if (Array.isArray(value)) for (const v of value) references(v, out, key);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) references(v, out, k);
  return [...out];
}
export async function parseImport(bytes, filename, provider) {
  safeName(filename);
  const zipped = bytes.subarray(0, 2).toString() === 'PK';
  const files = zipped ? await readZip(bytes) : new Map([[filename, bytes]]);
  const documents = [], assets = [], warnings = [], parsedFiles = new Set();
  const add = d => {
    if (documents.length >= 10000 || d.rawText.length > 128000 || Buffer.byteLength(JSON.stringify(d)) > 512000) fail('DOCUMENT_QUOTA_EXCEEDED', 413);
    documents.push({ ...d, order: documents.length, contentSha256: sha(JSON.stringify(d)) });
  };
  let supported = false;
  for (const [name, content] of files) {
    const base = name.split('/').pop();
    if (provider === 'chatgpt' && /^conversations(?:[-_]?\d+)?\.json$/i.test(base)) {
      const data = safeJson(content);
      if (!Array.isArray(data) || data.some(c => !c || typeof c.id !== 'string' || !c.mapping || typeof c.mapping !== 'object')) continue;
      for (const c of data) for (const [nodeId, node] of Object.entries(c.mapping)) {
        const m = node?.message;
        if (!m) continue;
        if (typeof m.id !== 'string' || !m.author || !m.content || !Array.isArray(m.content.parts)) { warnings.push('Unsupported message retained in original package: ' + nodeId); continue; }
        const parts = m.content.parts;
        add({ stableKey: 'chatgpt:' + c.id + ':' + m.id, externalConversationId: c.id, externalMessageId: m.id, parentId: node.parent || undefined, role: m.author.role,
          rawText: parts.flatMap(p => typeof p === 'string' ? [p] : typeof p?.text === 'string' ? [p.text] : []).join('\n'),
          rawTimestamp: m.create_time ?? null, metadata: { nodeId, title: c.title, references: references(m), contentTypes: parts.filter(p => typeof p !== 'string'), rawRecordHash: sha(JSON.stringify(m)) } });
      }
      parsedFiles.add(name); supported = true;
    } else if (provider === 'claude' && /conversations.*\.json$/i.test(base)) {
      if (process.env.BRAIN_ENABLE_EXPERIMENTAL_CLAUDE !== '1') { warnings.push('Claude adapter requires a validated real redacted fixture; original package retained as unsupported.'); continue; }
      const data = safeJson(content);
      if (!Array.isArray(data) || data.some(c => typeof c?.uuid !== 'string' || !Array.isArray(c.chat_messages))) continue;
      for (const c of data) for (const m of c.chat_messages) {
        if (typeof m.uuid !== 'string' || typeof m.sender !== 'string') fail('UNSUPPORTED_CLAUDE_MESSAGE');
        add({ stableKey: 'claude:' + c.uuid + ':' + m.uuid, externalConversationId: c.uuid, externalMessageId: m.uuid, role: m.sender,
          rawText: typeof m.text === 'string' ? m.text : (m.content || []).map(p => textContent(p.text)).join('\n'),
          rawTimestamp: m.created_at ?? null, metadata: { references: references(m), rawRecordHash: sha(JSON.stringify(m)), adapter: 'claude-experimental-1' } });
      }
      parsedFiles.add(name); supported = true; warnings.push('Experimental Claude adapter: tested synthetic structure only.');
    } else if (provider === 'orion-legacy' && !zipped) {
      const data = safeJson(content);
      if (data.schemaVersion !== 1 || !Array.isArray(data.messages) || !Array.isArray(data.conversations)) fail('UNSUPPORTED_LEGACY');
      for (const m of data.messages) add({ stableKey: 'orion-legacy:' + m._id, externalConversationId: m.sessionId, externalMessageId: String(m._id),
        role: String(m.user?.id) === '6946005372b6aea1602bf390' ? 'assistant' : 'user', rawText: textContent(m.content), rawTimestamp: m.createdDate ?? null,
        metadata: { senderId: m.user?.id, audit: m.vaultAudit, references: m.images || [], rawRecordHash: sha(JSON.stringify(m)) } });
      parsedFiles.add(name); supported = true;
    } else if (['manual', 'other'].includes(provider) && /\.(md|txt)$/i.test(base)) {
      const rawText = new TextDecoder('utf-8', { fatal: true }).decode(content);
      add({ stableKey: 'manual-import:' + sha(content), rawText, metadata: { references: [], unverifiedSummary: true, origin: 'manual-import; may be AI summary, not independently verified' } });
      parsedFiles.add(name); supported = true;
    } else if (['manual', 'other'].includes(provider) && /\.json$/i.test(base)) {
      const data = safeJson(content);
      if (data.schemaVersion !== 1 || !Array.isArray(data.documents)) continue;
      for (const d of data.documents) {
        if (typeof d.text !== 'string') fail('INVALID_MANUAL_DOCUMENT');
        add({ stableKey: 'other:' + (d.id || sha(d.text)), rawText: d.text, rawTimestamp: d.timestamp ?? null, metadata: { references: [], unverifiedSummary: true } });
      }
      parsedFiles.add(name); supported = true;
    }
  }
  for (const [name, data] of files) if (!parsedFiles.has(name) && zipped) assets.push({ name, bytes: data, sha256: sha(data), size: data.length, mimeType: 'application/octet-stream' });
  const missing = [];
  for (const doc of documents) {
    doc.assetNames = [];
    for (const ref of doc.metadata?.references || []) {
      const cleaned = ref.replace(/^file-service:\/\//, '');
      const matches = assets.filter(a => a.name === cleaned || a.name.split('/').pop() === cleaned || a.name.split('/').pop().startsWith(cleaned + '-'));
      if (matches.length === 1) doc.assetNames.push(matches[0].name);
      else { missing.push(ref); doc.assetNames.push('missing:' + ref); }
    }
  }
  return { documents, assets, missing: [...new Set(missing)], warnings: warnings.slice(0, 100), supported,
    formatVersion: provider === 'claude' ? 'experimental-1' : 'adapter-1' };
}
