import {createHash} from 'node:crypto';
import {ObjectId} from 'mongodb';
import {z} from 'zod';
import {normalizeR2References} from '../../../utils/r2Reference.js';

const ID=/^[a-f0-9]{24}$/i;
const RECEIPT_KEY=/^[A-Za-z0-9:_-]{8,128}$/;
const hash=s=>createHash('sha256').update(s).digest('hex');
const asId=s=>new ObjectId(s);
const snapshot=v=>JSON.parse(JSON.stringify(v));

export class FootprintMutationError extends Error {
  constructor(code,status=400){super(code);this.name='FootprintMutationError';this.status=status}
}
const fail=(code,status=400)=>{throw new FootprintMutationError(code,status)};

const locationSchema=z.object({
  country:z.string().max(100).optional(),
  province:z.string().max(160).optional(),
  city:z.string().max(160).optional(),
  district:z.string().max(160).optional(),
  name:z.string().trim().min(1).max(240),
  address:z.string().max(800).optional(),
  coordinates:z.tuple([
    z.number().finite().min(-180).max(180),
    z.number().finite().min(-90).max(90)
  ]),
  adcode:z.string().max(60).optional()
}).strict();
const positiveDate=z.union([
  z.string().max(64).refine(x=>Number.isFinite(Date.parse(x))),
  z.number().int().min(0).max(8640000000000000)
]).transform(x=>new Date(x));
const fields={
  location:locationSchema,
  content:z.string().max(2000),
  images:z.array(z.string().max(2048)).max(30),
  companions:z.array(z.string().max(100)).max(20),
  rating:z.number().int().min(1).max(5),
  mood:z.enum(['happy','excited','peaceful','tired','sad','romantic','adventurous']),
  cost:z.number().finite().min(0).max(1e10),
  visitDate:positiveDate,
  status:z.enum(['visited','planned']),
  isHighlight:z.boolean()
};
const createSchema=z.object({
  location:locationSchema,
  ...Object.fromEntries(Object.entries(fields)
    .filter(([key])=>key!=='location').map(([key,value])=>[key,value.optional()]))
}).strict();
const updateSchema=z.object(
  Object.fromEntries(Object.entries(fields).map(([key,val])=>[key,val.optional()]))
).strict();

export function parseFootprintMutation(raw){
  if(!raw||typeof raw!=='object')fail('INVALID_FOOTPRINT_INPUT');
  const {operation,id,key,body}=raw;
  if(!['create','update','delete'].includes(operation))fail('INVALID_FOOTPRINT_OPERATION');
  if(typeof key!=='string'||!RECEIPT_KEY.test(key))fail('IDEMPOTENCY_KEY_REQUIRED',428);
  if(operation!=='create' && (typeof id!=='string'||!ID.test(id)))fail('INVALID_FOOTPRINT_ID');
  if(operation==='delete'){
    if(body!==undefined && body!==null &&
      (typeof body!=='object'||Array.isArray(body)||Object.keys(body).length))
      fail('INVALID_FOOTPRINT_INPUT');
    return {operation,id,key,body:{}};
  }
  const parsed=(operation==='create'?createSchema:updateSchema).safeParse(body);
  if(!parsed.success || operation==='update'&&!Object.keys(parsed.data).length)
    fail('INVALID_FOOTPRINT_INPUT');
  return {operation,id:id||null,key,body:snapshot(parsed.data)};
}

/**
 * Current owner + FOOTPRINT:USE always checked inside the DB transaction,
 * including for replayed receipt reads. Do not trust the user's JWT role.
 */
async function currentOwner(db,session,caller){
  if(!caller||typeof caller.id!=='string'||!ID.test(caller.id))
    fail('UNAUTHORIZED',401);
  const ownerId=asId(caller.id);
  const owner=await db.collection('users').findOne({_id:ownerId},{
    session,projection:{role:1,extraPermissions:1}
  });
  if(!owner)fail('UNAUTHORIZED',401);
  const role=await db.collection('roles').findOne({name:owner.role||'user'},{
    session,projection:{permissions:1}
  });
  const rights=[...(Array.isArray(role?.permissions)?role.permissions:[]),
    ...(Array.isArray(owner.extraPermissions)?owner.extraPermissions:[])];
  if(owner.role!=='super_admin'&&!rights.includes('*')&&!rights.includes('FOOTPRINT:USE'))
    fail('PERMISSION_DENIED',403);
  return ownerId;
}

function patchForCreate(value,ownerId,time){
  const p=normalizeR2References(value);
  return {
    user:ownerId,
    companions:p.companions||[],
    location:{country:'中国',...p.location},
    content:p.content??'',
    images:p.images||[],
    rating:p.rating??5,
    mood:p.mood||'happy',
    ...(p.cost===undefined?{}:{cost:p.cost}),
    visitDate:p.visitDate?new Date(p.visitDate):time,
    status:p.status||'visited',
    isHighlight:p.isHighlight??false,
    createdAt:time,updatedAt:time,
    __v:0
  };
}
function patchForUpdate(value,time){
  const p=normalizeR2References(value);
  const change={};
  for(const [key,val] of Object.entries(p)){
    change[key]=key==='visitDate'?new Date(val):
      key==='location'?{country:'中国',...val}:val;
  }
  return {...change,updatedAt:time};
}

/**
 * Strictly bound to current database owner; no caller-provided owner override.
 * Atomic business document, audit_log, and idempotency receipt. Persist the
 * response with the receipt: deterministic retries after deletes are safe.
 */
export async function mutateOwnerFootprint({client,db},caller,raw){
  const args=parseFootprintMutation(raw);
  if(!ID.test(caller?.id||''))fail('UNAUTHORIZED',401);
  const receiptId='footprint:'+hash([caller.id,args.operation,args.key].join(':'));
  const contentHash=hash(JSON.stringify({operation:args.operation,
    id:args.id,body:args.body}));
  const receipts=db.collection('footprint_mutation_receipts');
  const session=client.startSession();
  let response;
  try {
    await session.withTransaction(async()=>{
      const ownerId=await currentOwner(db,session,caller);
      const prior=await receipts.findOne({_id:receiptId},{session});
      if(prior){
        if(prior.contentHash!==contentHash)fail('IDEMPOTENCY_CONFLICT',409);
        response=prior.response;
        return;
      }
      const table=db.collection('footprints');
      const time=new Date();
      let auditAction,receiptDetails,auditTarget;
      if(args.operation==='create'){
        const value=patchForCreate(args.body,ownerId,time);
        const inserted={_id:new ObjectId(),...value};
        await table.insertOne(inserted,{session});
        response=snapshot(inserted);
        auditAction='ADD_FOOTPRINT';
        auditTarget=value.location.name;
        receiptDetails={province:value.location.province,status:value.status};
      }else{
        const predicate={_id:asId(args.id),user:ownerId};
        const before=await table.findOne(predicate,{session});
        if(!before)fail('FOOTPRINT_NOT_FOUND',404);
        if(args.operation==='delete'){
          const deleted=await table.deleteOne(predicate,{session});
          if(deleted.deletedCount!==1)fail('FOOTPRINT_NOT_FOUND',404);
          response={msg:'Deleted successfully'};
          auditAction='DELETE_FOOTPRINT';
          auditTarget=before.location?.name||'';
          receiptDetails={id:asId(args.id)};
        }else{
          const patch=patchForUpdate(args.body,time);
          const updated=await table.findOneAndUpdate(predicate,{$set:patch},{
            session,returnDocument:'after'
          });
          if(!updated)fail('FOOTPRINT_NOT_FOUND',404);
          response=snapshot(updated);
          auditAction='UPDATE_FOOTPRINT';
          auditTarget=updated.location?.name||'';
          receiptDetails={id:asId(args.id),updatedFields:Object.keys(patch)
            .filter(k=>k!=='updatedAt')};
        }
      }
      await db.collection('audit_logs').insertOne({
        operator:ownerId,action:auditAction,
        target:String(auditTarget).slice(0,300),
        details:receiptDetails,createdDate:time
      },{session});
      await receipts.insertOne({
        _id:receiptId,ownerId,operation:args.operation,contentHash,
        response,createdAt:time
      },{session});
    },{
      readConcern:{level:'snapshot'},writeConcern:{w:'majority'},
      maxCommitTimeMS:25000
    });
  }catch(error){
    if(error?.code!==11000)throw error;
    // A parallel same-idempotency transaction may have committed first.
    // Recheck current RBAC before returning a receipt to a revoked owner.
    const check=client.startSession();
    try{
      await check.withTransaction(async()=>{
        await currentOwner(db,check,caller);
        const win=await receipts.findOne({_id:receiptId},{session:check});
        if(!win)throw error;
        if(win.contentHash!==contentHash)fail('IDEMPOTENCY_CONFLICT',409);
        response=win.response;
      },{readConcern:{level:'snapshot'}});
    }finally{await check.endSession()}
  }finally{await session.endSession()}
  return response;
}
