import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { nextTodoRun } from './todoReminders.js';
import { listOwnerTodos } from './todoReads.js';

const ID=/^[a-f0-9]{24}$/i;
const IDEMPOTENCY=/^[A-Za-z0-9:_-]{8,128}$/;
const sha=message=>createHash('sha256').update(message).digest('hex');
const now=()=>new Date();
const objectId=string=>new ObjectId(string);

export class TodoMutationError extends Error {
  constructor(code,status=400) {
    super(code);this.name='TodoMutationError';this.status=status;
  }
}
const fail=(code,status)=>{throw new TodoMutationError(code,status)};
const date=z.string().max(64).refine(s=>Number.isFinite(Date.parse(s))).nullable();
const optionalId=z.string().regex(ID);
const fields={
  todo:z.string().trim().min(1).max(2000),
  description:z.string().max(6000).optional(),
  images:z.array(z.string().max(2048)).max(24).optional(),
  targetDate:date.optional(),
  order:z.number().int().min(-10000).max(10000).optional(),
  type:z.enum(['wish','routine']).optional(),
  recurrence:z.string().max(120).nullable().optional(),
  remindAt:date.optional(),
  notifyUsers:z.array(optionalId).max(20).optional(),
  bark:z.object({
    sound:z.string().max(40).optional(),
    level:z.enum(['active','timeSensitive','passive','critical']).optional(),
    icon:z.string().max(2048).optional(),
    url:z.string().max(2048).optional(),
    image:z.string().max(2048).optional(),
    call:z.string().max(80).optional()
  }).strict().optional(),
  isActive:z.boolean().optional()
};
const createSchema=z.object(fields).strict();
const updateSchema=z.object({
  ...Object.fromEntries(Object.entries(fields).map(([key,val])=>[key,val.optional()])),
  status:z.string().min(1).max(60).optional(),
  done:z.union([z.boolean(),z.literal('true'),z.literal('false'),z.literal(1),z.literal(0)]).optional()
}).strict();

export function parseTodoMutation({operation,id,body,key}) {
  if(!['create','update','delete','check'].includes(operation)) fail('INVALID_TODO_OPERATION');
  if(typeof key!=='string'||!IDEMPOTENCY.test(key)) fail('TODO_IDEMPOTENCY_KEY_REQUIRED',428);
  if(operation!=='create' && (typeof id!=='string'||!ID.test(id))) fail('INVALID_TODO_ID');
  if(operation==='delete'||operation==='check') {
    if(body!==undefined && body!==null &&
      (typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)) fail('INVALID_TODO_INPUT');
    return {operation,id:id||null,key,body:{}};
  }
  const validated=(operation==='create'?createSchema:updateSchema).safeParse(body);
  if(!validated.success || operation==='update' && Object.keys(validated.data).length===0) fail('INVALID_TODO_INPUT');
  return {operation,id:id||null,key,body:validated.data};
}

async function ownerScope(db,session,caller) {
  if(!caller || typeof caller.id!=='string'||!ID.test(caller.id)) fail('UNAUTHORIZED',401);
  const id=objectId(caller.id);
  const user=await db.collection('users').findOne({_id:id},{
    session,projection:{role:1,extraPermissions:1,timezone:1}
  });
  if(!user) fail('UNAUTHORIZED',401);
  const role=await db.collection('roles').findOne({name:user.role||'user'},{
    session,projection:{permissions:1}
  });
  const rights=[...(role?.permissions||[]),...(user.extraPermissions||[])];
  if(user.role!=='super_admin'&&!rights.includes('*')&&!rights.includes('TODO:USE')) {
    fail('PERMISSION_DENIED',403);
  }
  const family=user.role==='super_admin'
    ? (await db.collection('users').find({role:'super_admin'},{
      projection:{_id:1},session
    }).toArray()).map(u=>u._id):[id];
  return {id,timezone:user.timezone||'Asia/Shanghai',
    allowedIds:family.length?family:[id]};
}

async function recipients(db,session,scope,input) {
  const raw=input?.length?input:[String(scope.id)];
  const ids=[...new Set(raw.map(String))].map(objectId);
  const allowed=new Set(scope.allowedIds.map(String));
  if(ids.some(x=>!allowed.has(String(x)))) fail('INVALID_NOTIFY_USERS',403);
  if(await db.collection('users').countDocuments({_id:{$in:ids}},{session})!==ids.length) {
    fail('INVALID_NOTIFY_USERS');
  }
  return ids;
}

function normalizeDate(value) {return value?new Date(value):null}
function makePatch(data,scope,isNew=false) {
  const patch={};
  for(const key of ['todo','description','images','order','type','isActive','bark']){
    if(data[key]!==undefined) patch[key]=data[key];
  }
  if(data.targetDate!==undefined) patch.targetDate=normalizeDate(data.targetDate);
  if(data.remindAt!==undefined) {
    patch.remindAt=normalizeDate(data.remindAt);patch.isNotified=false;
  }
  if(data.recurrence!==undefined) patch.recurrence=data.recurrence;
  if(isNew) {
    Object.assign(patch,{
      user:scope.id,type:data.type||'wish',description:data.description||'',
      images:data.images||[],order:data.order||0,
      isActive:data.isActive??true,
      status:'todo',done:false,isNotified:false,
      bark:{sound:'minuet',level:'active',icon:'',url:'',image:'',call:'',...data.bark},
      targetDate:data.targetDate?normalizeDate(data.targetDate):null,
      remindAt:data.remindAt?normalizeDate(data.remindAt):null,
      recurrence:data.type==='routine'?(data.recurrence||null):null
    });
    if(patch.type==='routine' && !patch.remindAt && patch.recurrence){
      patch.remindAt=nextTodoRun(patch.recurrence,now(),scope.timezone);
      if(!patch.remindAt) fail('INVALID_RECURRENCE');
    }
  }else if(data.status!==undefined){
    patch.status=data.status;patch.done=data.status==='done';
    if(patch.done)patch.complete_date=now().toISOString();
  }else if(data.done!==undefined){
    patch.done=[true,'true',1].includes(data.done);
    patch.status=patch.done?'done':'todo';
    if(patch.done)patch.complete_date=now().toISOString();
  }
  patch.updatedAt=now();
  if(isNew)patch.createdAt=patch.updatedAt;
  return patch;
}

async function legacyUnpagedList(db,caller) {
  const first=await listOwnerTodos(db,caller,{limit:'100',page:'1'});
  if(first.pagination.total>500) fail('TOO_MANY_TODOS_FOR_MUTATION_RESPONSE',503);
  const all=[...first.data];
  for(let page=2;page<=first.pagination.totalPages;page++){
    const next=await listOwnerTodos(db,caller,{limit:'100',page:String(page)});
    all.push(...next.data);
  }
  return all;
}

/**
 * DO rechecks live RBAC and family membership in an atomic MongoDB transaction.
 * The _id-hashed receipt prevents duplicate mutations even under concurrency.
 */
export async function mutateOwnerTodo({client,db},caller,raw){
  const args=parseTodoMutation(raw);
  if(!caller||!ID.test(caller.id||'')) fail('UNAUTHORIZED',401);
  const receiptId='todo:'+sha(caller.id+':'+args.operation+':'+args.key);
  const payloadHash=sha(JSON.stringify({
    operation:args.operation,id:args.id,body:args.body
  }));
  const receipts=db.collection('todo_mutation_receipts');
  // Even idempotent retries must revalidate current RBAC. Never return a
  // previous family task list after the operator lost TODO:USE permission.
  const session=client.startSession();
  let result;
  try{
    await session.withTransaction(async()=>{
      const scope=await ownerScope(db,session,caller);
      const receipt=await receipts.findOne({_id:receiptId},{session});
      if(receipt){
        if(receipt.payloadHash!==payloadHash)fail('IDEMPOTENCY_CONFLICT',409);
        result=receipt.result;return;
      }
      const todos=db.collection('todos');
      const filter=args.id?{_id:objectId(args.id),user:{$in:scope.allowedIds}}:null;
      const existing=filter?await todos.findOne(filter,{session}):null;
      if(args.operation!=='create'&&!existing)fail('TODO_NOT_FOUND',404);
      let action,target,details;
      const timestamp=now();
      if(args.operation==='create'){
        const patch=makePatch(args.body,scope,true);
        patch.notifyUsers=await recipients(db,session,scope,args.body.notifyUsers);
        const id=new ObjectId();
        await todos.insertOne({_id:id,...patch},{session});
        result={kind:'list'};
        action=patch.type==='routine'?'CREATE_ROUTINE':'CREATE_WISH';
        target=patch.todo;details={id,has_remind:Boolean(patch.remindAt)};
      }else if(args.operation==='update'){
        const patch=makePatch(args.body,scope);
        if(args.body.notifyUsers!==undefined){
          patch.notifyUsers=await recipients(db,session,scope,args.body.notifyUsers);
        }
        await todos.updateOne(filter,{$set:patch},{session});
        result={kind:'list'};
        action=patch.done?'FULFILL_WISH':'UPDATE_TASK';
        target=patch.todo||existing.todo;details={id:existing._id};
      }else if(args.operation==='check'){
        if(existing.type!=='routine'||!existing.recurrence)fail('NOT_ROUTINE');
        const user=await db.collection('users').findOne({_id:existing.user},{
          session,projection:{timezone:1}
        });
        const nextRun=nextTodoRun(
          existing.recurrence,timestamp,user?.timezone||'Asia/Shanghai'
        );
        if(!nextRun)fail('INVALID_RECURRENCE');
        await todos.updateOne(filter,{$set:{
          remindAt:nextRun,isNotified:false,updatedAt:timestamp
        }},{session});
        result={success:true,nextRun,msg:'打卡成功，下次提醒已更新'};
        action='CHECK_ROUTINE';target=existing.todo;details={id:existing._id};
      }else{
        await todos.deleteOne(filter,{session});
        result={success:true};
        action='DELETE_TASK';target=existing.todo;details={id:existing._id};
      }
      await db.collection('audit_logs').insertOne({
        operator:scope.id,action,target:String(target).slice(0,300),
        details,createdDate:timestamp
      },{session});
      await receipts.insertOne({
        _id:receiptId,operatorId:scope.id,action:args.operation,
        payloadHash,result,createdAt:timestamp
      },{session});
    },{
      readConcern:{level:'snapshot'},writeConcern:{w:'majority'},
      maxCommitTimeMS:25000
    });
  }catch(error){
    if(error?.code!==11000)throw error;
    const receipt=await receipts.findOne({_id:receiptId});
    if(!receipt)throw error;
    if(receipt.payloadHash!==payloadHash)fail('IDEMPOTENCY_CONFLICT',409);
    result=receipt.result;
  }finally{await session.endSession()}
  return result.kind==='list'?legacyUnpagedList(db,caller):result;
}

export async function readOwnerTodo(db,caller,id){
  if(!ID.test(id||'')||!ID.test(caller?.id||''))fail('INVALID_TODO_ID');
  let allowed=[objectId(caller.id)];
  if(caller.role==='super_admin'){
    allowed=(await db.collection('users').find({role:'super_admin'},{
      projection:{_id:1}
    }).toArray()).map(u=>u._id);
  }
  const todo=await db.collection('todos').findOne({
    _id:objectId(id),user:{$in:allowed}
  });
  if(!todo)fail('TODO_NOT_FOUND',404);
  const ids=[todo.user,...(todo.notifyUsers||[])].filter(
    value=>ID.test(String(value))
  );
  const users=await db.collection('users').find({
    _id:{$in:ids}
  },{projection:{displayName:1,photoURL:1,email:1}}).toArray();
  const map=new Map(users.map(u=>[String(u._id),u]));
  const owner=map.get(String(todo.user));
  return JSON.parse(JSON.stringify({
    description:'',type:'wish',recurrence:null,isNotified:false,
    status:'todo',done:false,images:[],order:0,isActive:true,...todo,
    bark:{sound:'minuet',level:'active',icon:'',url:'',image:'',call:'',
      ...(todo.bark||{})},
    user:owner?{_id:owner._id,displayName:owner.displayName,
      photoURL:owner.photoURL,email:owner.email}:null,
    notifyUsers:(todo.notifyUsers||[]).map(i=>map.get(String(i))).filter(Boolean)
      .map(u=>({_id:u._id,displayName:u.displayName,photoURL:u.photoURL}))
  }));
}
