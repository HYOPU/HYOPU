import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/documents.js';
const run=async req=>{let status,body;await handler(req,{status(n){status=n;return this;},json(v){body=v;return this;}});return {status,body};};
test('API reports missing configuration honestly and does not report a false save',async()=>{
 const previous={url:process.env.SUPABASE_URL,key:process.env.SUPABASE_SERVICE_ROLE_KEY};delete process.env.SUPABASE_URL;delete process.env.SUPABASE_SERVICE_ROLE_KEY;
 try{const get=await run({method:'GET'});assert.equal(get.body.configured,false);const post=await run({method:'POST',body:{}});assert.equal(post.status,503);assert.equal(post.body.saved,false);}finally{if(previous.url!==undefined)process.env.SUPABASE_URL=previous.url;if(previous.key!==undefined)process.env.SUPABASE_SERVICE_ROLE_KEY=previous.key;}
});
test('GET health checks bucket and table without writing documents',async()=>{
 const originalFetch=global.fetch,oldUrl=process.env.SUPABASE_URL,oldKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
 process.env.SUPABASE_URL='https://example.invalid';process.env.SUPABASE_SERVICE_ROLE_KEY='test-only';const calls=[];
 global.fetch=async(url,options)=>{calls.push({url,options});return {ok:true,status:200};};
 try{const result=await run({method:'GET'});assert.equal(result.status,200);assert.equal(result.body.healthy,true);assert.equal(calls.length,2);assert.ok(calls.every(c=>!c.options.method));assert.ok(!JSON.stringify(result).includes('test-only'));}finally{global.fetch=originalFetch;if(oldUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=oldUrl;if(oldKey===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;else process.env.SUPABASE_SERVICE_ROLE_KEY=oldKey;}
});
