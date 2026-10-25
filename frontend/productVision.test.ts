import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scoreProductImage} from './productVision';
class FakeWorker extends EventTarget{
 static instances:FakeWorker[]=[];terminated=false;message:any;
 constructor(..._args:any[]){super();FakeWorker.instances.push(this);}
 postMessage(message:any){this.message=message;}
 terminate(){this.terminated=true;}
 reply(data:any){this.dispatchEvent(new MessageEvent('message',{data:{id:this.message.id,...data}}));}
}
test('changing the product terminates visual inference and discards late old-image results',async()=>{
 const original=globalThis.Worker;Object.assign(globalThis,{Worker:FakeWorker});
 try{
  const abort=new AbortController();const progress:string[]=[];
  const old=scoreProductImage(new Blob(['old image']),['old'],abort.signal,text=>progress.push(text));
  const first=FakeWorker.instances.at(-1)!;first.reply({progress:'loading'});assert.deepEqual(progress,['loading']);
  abort.abort();await assert.rejects(old);assert(first.terminated);
  first.reply({scores:[{label:'old',score:1}]});assert.equal(progress.length,1);
  const next=scoreProductImage(new Blob(['new image']),['new'],new AbortController().signal,()=>{});
  const second=FakeWorker.instances.at(-1)!;assert.notEqual(first,second);
  second.reply({scores:[{label:'new',score:0.8}]});assert.deepEqual(await next,[{label:'new',score:0.8}]);
 }finally{Object.assign(globalThis,{Worker:original});}
});
