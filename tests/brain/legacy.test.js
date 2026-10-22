import { previewImport, commitImport } from '../../services/brain/imports.js';
import { BrainDocument } from '../../models/brain.js';
import Chat from '../../models/Chat.js';
import Conversation from '../../models/Conversation.js';
import { scanLegacy, BOT_ID } from '../../services/brain/legacy.js';
const owner = '654321000000000000000001';
test('Phase 0: cursor archive covers 51 conversations, 102 messages, bots, orphan and missing images without writes', async () => {
  await Conversation.insertMany(Array.from({ length: 51 }, (_, i) => ({ user: owner, sessionId: 'session-' + i })));
  await Chat.insertMany(
    Array.from({ length: 102 }, (_, i) => ({
      user: { id: i % 2 ? BOT_ID : owner, displayName: 'Synthetic' },
      room: 'ai_session_' + owner,
      sessionId: 'session-' + Math.floor(i / 2),
      content: '合成消息 ' + i,
      images: i === 0 ? ['https://not-fetched.invalid/missing.png'] : []
    })).concat([
      { user: { id: BOT_ID, displayName: 'Bot' }, room: 'ai_session_' + owner, sessionId: 'orphan', content: 'orphan' },
      {
        user: { id: owner, displayName: 'Foreign room' },
        room: 'ai_session_other',
        sessionId: 'session-0',
        content: 'excluded'
      }
    ])
  );
  const result = await scanLegacy(owner);
  expect(result.counts).toMatchObject({
    conversations: 51,
    messages: 103,
    botMessages: 52,
    orphanMessages: 1,
    missingAssets: 1
  });
  expect(await Chat.countDocuments()).toBe(104);
  expect(await Conversation.countDocuments()).toBe(51);
  expect(result.messages.some((m) => m.content === 'excluded')).toBe(false);
  const preview = await previewImport(owner, Buffer.from(JSON.stringify(result)), 'orion-legacy.json', 'orion-legacy');
  await commitImport(owner, String(preview._id));
  expect(await BrainDocument.countDocuments({ ownerId: owner })).toBe(103);
  expect(await BrainDocument.countDocuments({ ownerId: owner, role: 'assistant' })).toBe(52);
  expect(await Chat.countDocuments()).toBe(104);
});
