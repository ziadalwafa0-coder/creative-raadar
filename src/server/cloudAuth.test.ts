import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BlobPreconditionFailedError} from '@vercel/blob';

process.env.CREATIVE_RADAAR_DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'radaar-auth-'));
process.env.VERCEL='1';
const auth=await import('./auth.ts');
const {cloudAuthRecords}=await import('./cloudAuthRecords.ts');
const records=new Map<string,{value:any;etag:string}>();
let sequence=0;
const originals={...cloudAuthRecords};
cloudAuthRecords.read=async(key:string)=>records.get(key) || null;
cloudAuthRecords.write=async(key:string,value:any,etag?:string)=>{
  const before=records.get(key);
  if((before && before.etag!==etag) || (!before && etag)) throw new BlobPreconditionFailedError();
  records.set(key,{value:structuredClone(value),etag:String(++sequence)});
};
cloudAuthRecords.remove=async key=>{records.delete(key);};
after(()=>{Object.assign(cloudAuthRecords,originals);});

test('cloud sessions use private shared records, not instance-local sessions',async()=>{
  const issued=await auth.issueAuthSession('owner-cloud-a');
  assert.ok(records.size>0);assert.ok([...records.keys()].every(key=>!key.includes(issued.token)));
  assert.equal((await auth.verifyAuthSession(issued.token)).ownerId,'owner-cloud-a');
  assert.notEqual((await auth.issueAuthSession('owner-cloud-a')).token,issued.token);
});
test('logout revokes the same bearer token in shared storage',async()=>{
  const {token}=await auth.issueAuthSession('owner-cloud-b');
  assert.equal((await auth.verifyAuthSession(token)).valid,true);
  await auth.revokeAuthSession(token);
  assert.equal((await auth.verifyAuthSession(token)).valid,false);
});
test('expired and forged sessions are rejected',async()=>{
  const {token}=await auth.issueAuthSession('owner-cloud-c',-1);
  assert.equal((await auth.verifyAuthSession(token)).valid,false);
  assert.equal((await auth.verifyAuthSession('crs_unissued')).valid,false);
  assert.equal((await auth.verifyAuthSession(undefined)).valid,false);
});
test('shared login throttling blocks five failures and can reset',async()=>{
  const key='mock-client';
  for(let i=0;i<5;i++) await auth.recordSharedLoginFailure(key);
  assert.equal((await auth.checkSharedLoginLimit(key)).allowed,false);
  await auth.resetSharedLoginFailures(key);
  assert.equal((await auth.checkSharedLoginLimit(key)).allowed,true);
});
test('concurrent failed logins cannot lose rate-limit updates',async()=>{
  await Promise.all(Array.from({length:5},()=>auth.recordSharedLoginFailure('parallel-client')));
  assert.equal((await auth.checkSharedLoginLimit('parallel-client')).allowed,false);
});
test('storage failures do not issue fake successful sessions',async()=>{
  const writer=cloudAuthRecords.write;
  cloudAuthRecords.write=async()=>{throw new Error('Store temporarily unavailable');};
  try {await assert.rejects(auth.issueAuthSession('owner-cloud-d'));}
  finally {cloudAuthRecords.write=writer;}
});
