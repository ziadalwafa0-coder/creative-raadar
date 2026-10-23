import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

test('HTTP simulation uses isolated synthetic projects and no external services', async t => {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'radaar-http-'));
  process.env.CREATIVE_RADAAR_DATA_DIR=dataDir;
  const { issueAuthSession }=await import('./auth.ts');
  const {token}=issueAuthSession('owner-http-simulation');
  const socket=net.createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=(socket.address() as net.AddressInfo).port;
  await new Promise<void>(resolve=>socket.close(()=>resolve()));
  const child=spawn(process.execPath,['--import','tsx','server.ts'],{cwd:process.cwd(),windowsHide:true,env:{...process.env,CREATIVE_RADAAR_DATA_DIR:dataDir,GEMINI_API_KEY:'',NODE_ENV:'production',PORT:String(port)},stdio:['ignore','pipe','pipe']});
  try {
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Test server startup timed out')),15000);
      child.stdout.on('data',b=>{if(String(b).includes('server running')){clearTimeout(timer);resolve();}});
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Test server exited ${code}`));});
    });
    const api=async(route:string,method='GET',body?:unknown)=>fetch(`http://127.0.0.1:${port}/api${route}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    const create=async(name:string)=>{
      const response=await api('/projects','POST',{name,mediaTypeRequested:'video',referenceImages:[{id:'image',url:'data:image/png;base64,AAA',base64Data:'AAA',mimeType:'image/png',fileName:'fixture.png'}]});
      assert.equal(response.status,201);return response.json();
    };
    const a=await create('9 Tier Shoe Rack with Cover');const b=await create('Double Rail Clothes Garment Rack with Wheels');
    await t.test('independent projects receive different identity fingerprints',()=>{
      assert.notEqual(a.id,b.id);assert.notEqual(a.searchInputFingerprint,b.searchInputFingerprint);
    });
    await t.test('a client cannot inject A results into B',async()=>{
      const response=await api(`/projects/${b.id}`,'PATCH',{candidates:[{id:'foreign-video',projectId:a.id,mediaUrl:'https://example.com/old.mp4'}]});
      assert.equal(response.status,200);assert.deepEqual((await response.json()).candidates,[]);
    });
    await t.test('changing product invalidates and archives its previous profile',async()=>{
      await api(`/projects/${a.id}`,'PATCH',{productProfile:{confidence:'high',suggestedNameEn:'9 Tier Shoe Rack with Cover'}});
      const response=await api(`/projects/${a.id}`,'PATCH',{name:'Double Rail Clothes Garment Rack with Wheels'});const updated=await response.json();
      assert.equal(response.status,200);assert.equal(updated.productProfile,undefined);assert.notEqual(updated.searchInputFingerprint,a.searchInputFingerprint);
      assert.equal(updated.previousSearches[0].productProfile.suggestedNameEn,'9 Tier Shoe Rack with Cover');
      assert.equal((await (await api(`/projects/${b.id}`)).json()).name,b.name);
    });
    await t.test('image search without vision configuration returns no fabricated matches',async()=>{
      assert.equal((await api(`/projects/${b.id}/search`,'POST',{})).status,200);
      const updated=await (await api(`/projects/${b.id}`)).json();
      assert.equal(updated.jobState,'needs_configuration');assert.equal(updated.candidates.length,0);
    });
    await t.test('project access still requires authentication',async()=>{
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/projects/${b.id}`)).status,401);
    });
  } finally {
    child.kill();await new Promise<void>(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',()=>resolve());});
  }
});
