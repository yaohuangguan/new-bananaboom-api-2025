import express from 'express';
import request from 'supertest';
import { Types } from 'mongoose';
import footprintRouter from '../routes/footprint.js';
import Footprint from '../models/Footprint.js';
import AuditLog from '../models/AuditLog.js';

const owner = new Types.ObjectId();
const unrelated = new Types.ObjectId();

// Test-only app injects the authenticated identity. Production adds auth
// and GlobalGuard before reaching the same footprint router.
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = req.header('x-test-owner') ? { id: req.header('x-test-owner') } : null;
  next();
});
app.use('/api/footprints', footprintRouter);

const actAs = (actor, method, id) =>
  request(app)[method]('/api/footprints/' + id)
    .set('x-test-owner', String(actor));

async function assertAuditPersisted(action) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await AuditLog.exists({ action })) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Footprint audit did not persist: ' + action);
}

let record;
beforeEach(async () => {
  record = await Footprint.create({
    user: owner,
    location: { name:'Auckland Park', coordinates:[174.76,-36.85] },
    visitDate:new Date('2026-11-01T00:00:00Z'),
    status:'visited',
    content:'Private personal travel record'
  });
});

describe('Footprint ID ownership security', () => {
  it('rejects unauthenticated detail, update and delete', async() => {
    const id = record._id;
    expect((await request(app).get('/api/footprints/'+id)).status).toBe(401);
    expect((await request(app).put('/api/footprints/'+id).send({content:'changed'})).status).toBe(401);
    expect((await request(app).delete('/api/footprints/'+id)).status).toBe(401);
    expect((await Footprint.findById(id)).content).toBe('Private personal travel record');
  });

  it('does not disclose, change or delete another user footprint by guessed ID', async() => {
    const id = record._id;
    const read = await actAs(unrelated,'get',id);
    expect(read.status).toBe(404);
    const update = await actAs(unrelated,'put',id).send({content:'hijacked',status:'planned'});
    expect(update.status).toBe(404);
    const deleteResult = await actAs(unrelated,'delete',id);
    expect(deleteResult.status).toBe(404);
    const unchanged = await Footprint.findById(id);
    expect(unchanged).not.toBeNull();
    expect(unchanged.content).toBe('Private personal travel record');
    expect(unchanged.status).toBe('visited');
  });

  it('allows owner to read and update own record without affecting other users', async() => {
    const id = record._id;
    const response = await actAs(owner,'get',id);
    expect(response.status).toBe(200);
    expect(response.body.content).toBe('Private personal travel record');
    const update = await actAs(owner,'put',id).send({content:'Updated privately'});
    expect(update.status).toBe(200);
    expect(update.body.content).toBe('Updated privately');
    expect((await Footprint.findById(id)).content).toBe('Updated privately');
    await assertAuditPersisted('UPDATE_FOOTPRINT');
  });

  it('allows owner to delete own record', async() => {
    const id = record._id;
    const response=await actAs(owner,'delete',id);
    expect(response.status).toBe(200);
    expect(response.body.msg).toBe('Deleted successfully');
    expect(await Footprint.findById(id)).toBeNull();
    await assertAuditPersisted('DELETE_FOOTPRINT');
  });
});
