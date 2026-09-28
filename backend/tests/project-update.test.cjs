'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProjectUpdates, compareVersions } = require('../project-update.cjs');
const { version } = require('../project-version.json');
test('semantic versions compare numerically and reject invalid remote values', () => {
  assert.equal(compareVersions('3.10.0','3.9.0'),1);
  assert.equal(compareVersions(version,version),0);
  assert.equal(compareVersions('2.9.9',version),-1);
  for (const value of ['v3.0.0','3.0','<script>','03.0.1']) assert.throws(() => compareVersions(value,version));
});
test('local info never fetches; checks coalesce and expire after a minute', async () => {
  let calls=0, time=1000;
  const updates=createProjectUpdates({now:()=>time,fetchImpl:async (url,options)=>{
    calls++;
    assert.equal(new URL(url).hostname,'raw.githubusercontent.com');
    assert.equal(options.redirect,'error');
    assert.equal(options.headers.Authorization,undefined);
    return Response.json({version:'3.10.0'});
  }});
  assert.equal(updates.info().version,version);assert.equal(calls,0);
  const [a,b]=await Promise.all([updates.check(),updates.check()]);
  assert.equal(a.status,'available');assert.deepEqual(a,b);assert.equal(calls,1);
  await updates.check();assert.equal(calls,1);
  time+=60001;await updates.check();assert.equal(calls,2);
});
test('equal and locally newer versions are distinguished',async()=>{
  for(const [v,status] of [[version,'current'],['1.0.0','ahead']]) {
    const updates=createProjectUpdates({fetchImpl:async()=>Response.json({version:v})});
    assert.equal((await updates.check()).status,status);
  }
});
test('network failures and invalid/oversized manifests never claim latest', async()=>{
  for(const impl of [async()=>{throw new Error('private network details');},async()=>new Response('',{status:429}),async()=>Response.json({version:'bad'}),async()=>new Response('x'.repeat(5000))]) {
    const updates=createProjectUpdates({fetchImpl:impl});
    const result=await updates.check();assert.equal(result.status,'error');assert.equal(result.latestVersion,undefined);
    assert.ok(!result.message.includes('private'));
  }
});
