import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseAmazonQuery,amazonQueries} from '../src/queryAi.ts';
import {buildApp} from '../src/index.ts';
import {createAuth} from '../src/auth.ts';
test('AI query parser keeps unique bounded English phrases only',()=>{
 assert.deepEqual(parseAmazonQuery('```json\n{"queries":[" Shoe rack ","Shoe rack","جزامة","","9 tier shoe rack"],"productType":"shoe rack"}\n```').queries,['Shoe rack','9 tier shoe rack']);
 assert.throws(()=>parseAmazonQuery('broken'),/AI_BAD_JSON/);assert.throws(()=>parseAmazonQuery('{"queries":["عربي"]}'),/AI_EMPTY/);
});
test('Gemini request uses a header key, optional image, JSON output and bounded model path',async()=>{
 let request:any;
 const result=await amazonQueries({name:'جزامة',market:'amazon.com',thumbnailJpegBase64:'aW1hZ2U='},{apiKey:'test-only',fetcher:async(url,init)=>{request={url,init,body:JSON.parse(String(init?.body))};return Response.json({candidates:[{content:{parts:[{text:'{"queries":["fabric shoe rack"]}'}]}}]});}});
 assert.deepEqual(result.queries,['fabric shoe rack']);assert.equal(request.init.headers['x-goog-api-key'],'test-only');assert(!request.url.includes('test-only'));assert.equal(request.body.contents[0].parts[1].inline_data.mime_type,'image/jpeg');
 await assert.rejects(amazonQueries({name:'rack',market:'amazon.com'},{apiKey:''}),/AI_NOT_CONFIGURED/);
 await assert.rejects(amazonQueries({name:'rack',market:'amazon.com'},{apiKey:'test',model:'../bad'}),/AI_MODEL_INVALID/);
});
test('query endpoint is authenticated, validates input and supports an injected free helper',async()=>{
 const auth=createAuth();let received:any;const app=await buildApp({logging:false,auth,queryAi:async(input)=>{received=input;return{queries:['shoe rack'],productType:'rack'};}});
 const headers={authorization:'Bearer '+auth.issue('session','test')};
 try{
  assert.equal((await app.inject({method:'POST',url:'/api/amazon-query',payload:{name:'rack'}})).statusCode,401);
  for(const payload of [{name:'a'},{name:'rack',market:'evil'},{name:'rack',thumbnailJpegBase64:'data:image/png,abc'}])assert.equal((await app.inject({method:'POST',url:'/api/amazon-query',headers,payload})).statusCode,400);
  const response=await app.inject({method:'POST',url:'/api/amazon-query',headers,payload:{name:'  جزامة   خشب  '}});assert.equal(response.statusCode,200);assert.deepEqual(response.json().queries,['shoe rack']);assert.equal(received.name,'جزامة خشب');
 }finally{await app.close();}
 const missing=await buildApp({logging:false,auth,queryAi:input=>amazonQueries(input,{apiKey:''})});
 try{assert.equal((await missing.inject({method:'POST',url:'/api/amazon-query',headers,payload:{name:'rack'}})).statusCode,501);}finally{await missing.close();}
});
