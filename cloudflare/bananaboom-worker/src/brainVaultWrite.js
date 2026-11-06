import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import {
  BRAIN_API_RESOURCE, BRAIN_MCP_RESOURCE,
  BrainReadError, verifyBrainReadConnection
} from './brainRead.js';
import { putBrainPrivateObject, BrainStorageFailure } from './brainPrivateStorage.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const validId = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
const fail = (code, status = 400) => { throw new BrainReadError(code, status); };
const LEVELS = ['normal','sensitive','restricted'];
const TYPES = ['instruction','identity','career','project','preference','decision','fact','other'];
const now = () => new Date();
const privacy = text => ({
  normalizedText: text.normalize('NFKC').toLowerCase()
});
function gramKey(gram) {
  let hash=2166136261;
  for(let i=0;i<gram.length;i++) hash=Math.imul(hash^gram.charCodeAt(i),16777619);
  return 'g'+((hash>>>0)%8192);
}
function fields(text) {
  const normalizedText=text.normalize('NFKC').toLowerCase();
  const chars=Array.from(normalizedText);
  const searchGrams=[...new Set(chars.flatMap((ch,i) =>
    i+1<chars.length ? [gramKey(ch),gramKey(ch+chars[i+1])] : [gramKey(ch)]))];
  return {normalizedText,searchGrams};
}

/**
 * Schema field order, strictness, defaults and trim behavior deliberately
 * match services/brain/sync.js so legacy request hash receipts are compatible.
 */
export const brainSyncSchema = z.object({
  requestId:z.string().min(8).max(128).regex(/^[a-zA-Z0-9:_-]+$/),
  statement:z.string().trim().min(1).max(20000),
  type:z.enum(TYPES).optional(),
  tags:z.array(z.string().max(80)).max(20).optional(),
  eventAt:z.string().refine(v=>Number.isFinite(Date.parse(v))).nullable().optional(),
  memoryId:z.string().regex(/^[a-f0-9]{24}$/i).optional(),
  expectedRevision:z.number().int().min(1).optional(),
  sensitivity:z.enum(LEVELS).default('normal'),
  note:z.string().max(500).optional()
}).strict();

function parseSync(raw) {
  const parsed=brainSyncSchema.safeParse(raw);
  if(!parsed.success) fail('INVALID_SYNC_INPUT');
  const data=parsed.data;
  if(data.memoryId && !data.expectedRevision) fail('EXPECTED_REVISION_REQUIRED');
  if(!data.memoryId && data.expectedRevision) fail('MEMORY_ID_REQUIRED');
  return data;
}

function safePublicRow(raw) {
  const row=JSON.parse(JSON.stringify(raw));
  const { privateObjectKey:_key, normalizedText:_normalized, searchGrams:_grams, ...safe }=row;
  return safe;
}

async function sourceAndDocument(db, session, ownerId, connection, data, originalBytes, privateObjectKey) {
  const sourceId=new ObjectId();
  const documentId=new ObjectId();
  const source={
    _id:sourceId,ownerId,provider:connection.provider,sourceType:'api-sync',
    originalFilename:'knowledge-sync.json',
    originalSha256:sha(originalBytes),
    privateObjectKey,status:'ready',formatVersion:'orion-sync-1',
    importedAt:now(),
    metadata:{
      connectionId:String(connection._id),
      clientName:connection.label,aiGenerated:true,
      independentlyVerified:false, documentIds:[documentId]
    }
  };
  await db.collection('brainsources').insertOne(source,{session});
  const document={
    _id:documentId,ownerId,sourceId,stableKey:
      'sync:'+String(connection._id)+':'+data.requestId,
    rawText:data.statement,rawJsonRef:'original#/statement',
    contentSha256:sha(data.statement),
    rawTimestamp:data.eventAt||null,
    metadata:{aiGenerated:true,connectionId:String(connection._id)},
    ...fields(data.statement)
  };
  await db.collection('braindocuments').insertOne(document,{session});
  return {sourceId,documentId};
}

function createdMemory(ownerId, sourceId, documentId, data) {
  const date=now();
  const value={
    _id:new ObjectId(),ownerId,sourceId,
    statement:data.statement,
    type:data.type||'fact',
    tags:data.tags||[],
    eventAt:data.eventAt ? new Date(data.eventAt) : null,
    sensitivity:data.sensitivity,
    reviewStatus:'candidate',
    sourceAnchors:[{documentId,quote:data.statement}],
    revision:1,capturedAt:date,createdAt:date,updatedAt:date,
    ...fields(data.statement)
  };
  return value;
}
function patchMemory(old, sourceId, documentId, data) {
  const change={
    sourceId,statement:data.statement,
    sensitivity:LEVELS[Math.max(
      LEVELS.indexOf(old.sensitivity||'normal'),LEVELS.indexOf(data.sensitivity)
    )],
    reviewStatus:'candidate',
    sourceAnchors:[{documentId,quote:data.statement}],
    revision:old.revision+1,updatedAt:now(),
    ...fields(data.statement)
  };
  if(data.type!==undefined) change.type=data.type;
  if(data.tags!==undefined) change.tags=data.tags;
  if(data.eventAt!==undefined) change.eventAt=data.eventAt ? new Date(data.eventAt) : null;
  return change;
}

async function saveTransaction(db,session,connection,userOwner,receiptFilter,data,payloadHash,blobKey,bytes) {
  const receipts=db.collection('brainsyncreceipts');
  const previous=await receipts.findOne(receiptFilter,{session});
  if(previous) {
    if(previous.payloadHash!==payloadHash) fail('IDEMPOTENCY_CONFLICT',409);
    return previous.result;
  }
  // Recheck revocation and current privileges inside the transactional snapshot.
  const active=await db.collection('brainconnections').findOne({
    _id:connection._id,ownerId:userOwner,revokedAt:null,
    expiresAt:{$gt:now()}
  },{session});
  if(!active) fail('INVALID_CONNECTION_TOKEN',401);
  const user=await db.collection('users').findOne(
    {_id:userOwner},{session,projection:{role:1,extraPermissions:1}}
  );
  const role=user && await db.collection('roles').findOne(
    {name:user.role},{session,projection:{permissions:1}}
  );
  const effective=[...(role?.permissions||[]),...(user?.extraPermissions||[])];
  if(!effective.includes('*')&&!effective.includes('BRAIN:USE')) {
    fail('BRAIN_PERMISSION_REQUIRED',403);
  }

  let old=null;
  if(data.memoryId) {
    old=await db.collection('brainmemories').findOne({
      _id:new ObjectId(data.memoryId),ownerId:userOwner,deletedAt:null
    },{session});
    if(!old) fail('NOT_FOUND',404);
    if(old.revision!==data.expectedRevision) fail('REVISION_CONFLICT',409);
  }
  const {sourceId,documentId}=await sourceAndDocument(
    db,session,userOwner,connection,data,bytes,blobKey
  );
  const reason='AI sync via '+connection.label+(data.note?': '+data.note:'');
  let before, after;
  if(!old) {
    after=createdMemory(userOwner,sourceId,documentId,data);
    await db.collection('brainmemories').insertOne(after,{session});
  }else{
    before=old;
    const changes=patchMemory(old,sourceId,documentId,data);
    after=await db.collection('brainmemories').findOneAndUpdate(
      {_id:old._id,ownerId:userOwner,revision:old.revision},
      {$set:changes},{session,returnDocument:'after'}
    );
    if(!after) fail('REVISION_CONFLICT',409);
  }
  await db.collection('brainrevisions').insertOne({
    ownerId:userOwner,actorId:userOwner,memoryId:after._id,
    action:old?'update':'create',
    ...(before?{before}:{}),
    after,revisionNumber:after.revision,
    reason,editedAt:now()
  },{session});

  const result=JSON.parse(JSON.stringify({
    memory:safePublicRow(after),created:!old,requestId:data.requestId
  }));
  await receipts.insertOne({
    ...receiptFilter,payloadHash,result,createdAt:now()
  },{session});
  await db.collection('brainconnections').updateOne(
    {_id:connection._id,ownerId:userOwner,revokedAt:null},
    {$set:{lastWriteAt:now()}},{session}
  );
  return result;
}

/**
 * Idempotent, owner-scoped transaction over existing Mongoose collection names.
 * The original ORIONV1 encrypted object is written to private R2 first, as in
 * the legacy service. A failed DB transaction may leave an immutable orphan;
 * it can never create partially committed memory/source/revision records.
 */
export async function syncBrainKnowledge({client,db,bucket,secret},token,raw,resource=BRAIN_API_RESOURCE) {
  if(!client || !db || !bucket || !secret) {
    throw new BrainStorageFailure();
  }
  const principal=await verifyBrainReadConnection(db,token,resource);
  if(!principal.scopes.includes('memory:write')) fail('INSUFFICIENT_SCOPE',403);
  const data=parseSync(raw);
  const ownerId=principal.ownerId;
  const connectionId=principal.connectionId;
  const filter={ownerId,connectionId,requestId:data.requestId};
  const payloadHash=sha(JSON.stringify(data));
  const receipts=db.collection('brainsyncreceipts');
  const existing=await receipts.findOne(filter);
  if(existing) {
    if(existing.payloadHash!==payloadHash) fail('IDEMPOTENCY_CONFLICT',409);
    return existing.result;
  }
  // Fail foreign, deleted and stale revisions BEFORE uploading any
  // encrypted object. Transaction repeats these checks against its snapshot.
  if(data.memoryId) {
    const current=await db.collection('brainmemories').findOne({
      _id:new ObjectId(data.memoryId),ownerId,deletedAt:null
    },{projection:{revision:1}});
    if(!current) fail('NOT_FOUND',404);
    if(current.revision!==data.expectedRevision) fail('REVISION_CONFLICT',409);
  }
  const connection=await db.collection('brainconnections').findOne({
    _id:connectionId,ownerId,revokedAt:null,expiresAt:{$gt:now()}
  });
  if(!connection) fail('INVALID_CONNECTION_TOKEN',401);
  if(!['chatgpt','claude','other'].includes(connection.provider) ||
      typeof connection.label!=='string' ||
      connection.label.length>80) fail('INVALID_CONNECTION_TOKEN',401);

  const bytes=Buffer.from(JSON.stringify({
    format:'orion-sync-1',
    connectionId:String(connectionId),
    provider:connection.provider,
    ...data
  }));
  const privateObjectKey=await putBrainPrivateObject(
    {bucket,secret},String(ownerId),bytes
  );

  const session=client.startSession();
  try {
    let outcome;
    await session.withTransaction(async()=>{
      outcome=await saveTransaction(
        db,session,connection,ownerId,filter,data,payloadHash,privateObjectKey,bytes
      );
    },{
      readConcern:{level:'snapshot'},
      writeConcern:{w:'majority'},
      maxCommitTimeMS:25000
    });
    return outcome;
  } catch(error) {
    if(error?.code!==11000) throw error;
    const winner=await receipts.findOne(filter);
    if(!winner || winner.payloadHash!==payloadHash) fail('IDEMPOTENCY_CONFLICT',409);
    return winner.result;
  } finally {
    await session.endSession();
  }
}
