import Chat from '../../models/Chat.js';
import Conversation from '../../models/Conversation.js';

export const BOT_ID = '6946005372b6aea1602bf390';
const MAX_RECORDS = 10000;

// Read only: never call an old HTTP endpoint or mutate Chat/Conversation.
// Cursor reads deliberately do not inherit either legacy 50-row UI limit.
export async function scanLegacy(ownerId, { ChatModel = Chat, ConversationModel = Conversation } = {}) {
  const conversations = [];
  const messages = [];
  for await (const row of ConversationModel.find({ user: ownerId }).sort({ _id: 1 }).lean().cursor()) {
    if (conversations.length >= MAX_RECORDS) throw new Error('LEGACY_QUOTA_EXCEEDED');
    conversations.push(row);
  }
  const sessions = new Set(conversations.map(c => c.sessionId));
  const counts = { conversations: conversations.length, messages: 0, botMessages: 0, orphanMessages: 0, unknownSenders: 0, missingAssets: 0 };
  for await (const row of ChatModel.find({ room: `ai_session_${ownerId}` }).sort({ _id: 1 }).lean().cursor()) {
    if (messages.length >= MAX_RECORDS) throw new Error('LEGACY_QUOTA_EXCEEDED');
    const sender = String(row.user?.id || '');
    const orphan = !sessions.has(row.sessionId);
    const unknownSender = sender !== String(ownerId) && sender !== BOT_ID;
    counts.messages++;
    counts.botMessages += Number(sender === BOT_ID);
    counts.orphanMessages += Number(orphan);
    counts.unknownSenders += Number(unknownSender);
    counts.missingAssets += (row.images || []).length;
    messages.push({ ...row, vaultAudit: { orphan, unknownSender, attachmentsUnverified: (row.images || []).length } });
  }
  return { schemaVersion: 1, provider: 'orion-legacy', conversations, messages, counts,
    warnings: ['Attachment URLs are references only; no remote objects were fetched. Original databases remain unchanged.'] };
}
