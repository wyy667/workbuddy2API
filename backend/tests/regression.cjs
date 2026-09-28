// Read-only code audit: production source is copied into a temporary sandbox.
// The child uses synthetic credentials and blocks/replaces ALL upstream fetches.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const assert = require('node:assert/strict');
// CI on shared VPS may be descheduled; semantic timeout assertions remain mandatory.
const timingAllowance = Number(process.env.TEST_TIMING_ALLOWANCE_MS || 0);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (process.argv[2] === '--child') {
  process.env.CB_GEO_DISABLED = '1';
  const dir = process.env.AUDIT_SANDBOX;
  os.homedir = () => dir;
  const realTimeout = global.setTimeout;
  const intervalCallbacks = global.__auditIntervals = [];
  global.setInterval = (fn, ms) => {intervalCallbacks.push({fn, ms});return { unref() {} };};
  global.setTimeout = (fn, ms, ...args) => ms === 8000 ? { unref() {} } : realTimeout(fn, ms, ...args);
  const audit = global.__audit = { starts: 0, active: 0, maxActive: 0, aborts: 0, cancels: 0 };
  global.fetch = async (url, opts = {}) => {
    // No network call is made from this mock.
    if (!String(url).endsWith('/chat/completions')) throw Error('Upstream network disabled by audit harness');
    const payload = JSON.parse(opts.body);
    if (payload.model === 'claude-audit-unavailable') return new Response(JSON.stringify({error:{message:'model not found'}}),{status:404});
    audit.starts++; audit.active++; audit.maxActive = Math.max(audit.maxActive, audit.active);
    let settled = false, timer, pulse;
    const end = () => { if (settled) return false; settled = true; audit.active--; clearTimeout(timer); clearInterval(pulse); return true; };
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: '+JSON.stringify({model:payload.model,choices:[{index:0,delta:{content:payload.model==='audit-words-success'?'内容审核与敏感词的正常说明':'A'}}]})+'\n\n'));
        opts.signal?.addEventListener('abort', () => {
          audit.aborts++; if (end()) controller.error(new DOMException('Mock aborted', 'AbortError'));
        }, {once:true});
        if (payload.model.includes('budget')) {
          const beat=()=>{if (!settled) {controller.enqueue(encoder.encode(': heartbeat\n\n')); timer=realTimeout(beat,20);}};
          timer=realTimeout(beat,20);return;
        }
        timer = realTimeout(() => {
          if (!end()) return;
          if (payload.model.includes('stream-error')) { controller.error(Error('Synthetic upstream stream failure')); return; }
          controller.enqueue(encoder.encode('data: '+JSON.stringify({model:payload.model,choices:[{index:0,delta:{},finish_reason:payload.model==='audit-filter-success'?'content_filter':'stop'}],usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3}})+'\n\ndata: [DONE]\n\n'));
          controller.close();
        }, payload.model.includes('success') || payload.model.includes('stream-error') || payload.model==='hy4-preview' ? 20 : 450);
      },
      cancel() { audit.cancels++; end(); },
    });
    return new Response(stream, {status:200,headers:{'Content-Type':'text/event-stream'}});
  };
  const Module = require('node:module');
  const file = path.join(dir, 'server.cjs');
  const mod = new Module(file, module);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(dir);
  const instrumentation = `
server.on('listening', () => process.send({ready:true,port:server.address().port}));
process.on('message', job => {
  if (job.action === 'optimizationChecks') {
    (async()=>{
      const cm=credManager(cred.path);cm.session();
      const originalRead=fs.readFileSync,originalStat=fs.statSync;let reads=0,stats=0;
      fs.readFileSync=(...a)=>{reads++;return originalRead(...a)};fs.statSync=(...a)=>{stats++;return originalStat(...a)};
      try {for(let i=0;i<25;i++)cm.session();} finally {fs.readFileSync=originalRead;fs.statSync=originalStat;}
      let disconnected=false;const slow={writableLength:300000,destroy(){disconnected=true},write(){throw Error('must not write')}};LIVE_CLIENTS.add(slow);liveWrite(slow,'frame');
      let enter,release,syncFlush=false;const started=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
      const fn=()=>{enter();return gate};fn.sync=()=>{syncFlush=true};deferWrite('audit-flush',fn,1);await started;flushDeferredWrites();release();
      process.send({id:job.id,result:{credentialReads:reads,credentialStats:stats,slowDisconnected:disconnected,inflightFlushed:syncFlush}});
    })().catch(e=>process.send({id:job.id,result:{error:e.message}}));return;
  }
  if (job.action === 'snapshot') process.send({id:job.id,result:{audit:global.__audit,leases:{...acctInflight},errors:STATS.errors,last:RECENT_REQUESTS.at(-1),keyUsage:apiKeys[0].usage}});
  if (job.action === 'slowModels') {global.__restoreModels=getAvailableModels;getAvailableModels=()=>new Promise(()=>{});process.send({id:job.id,result:true});}
  if (job.action === 'restoreModels') {getAvailableModels=global.__restoreModels;process.send({id:job.id,result:true});}
  if (job.action === 'fatal') { setTimeout(()=>{throw new Error('Synthetic fatal exception')},10); return; }
  if (job.action === 'diskFail') { const real=fs.renameSync;global.__restoreRename=()=>{fs.renameSync=real};fs.renameSync=()=>{const e=new Error('Synthetic disk full');e.code='ENOSPC';throw e};process.send({id:job.id,result:true}); }
  if (job.action === 'diskRecover') {global.__restoreRename();process.send({id:job.id,result:true});}
  if (job.action === 'adapters') {
    for (const type of ['opencode','trae','qoder']) BUILTIN_EXT[type].chat=async (prov,model,payload,stream,signal)=>({resp:await fetch('https://synthetic.invalid/chat/completions',{body:JSON.stringify({...payload,model}),signal}),onData:raw=>JSON.parse(raw)});
    process.send({id:job.id,result:true});
  }
  if (job.action === 'reset') { Object.assign(global.__audit,{starts:0,active:0,maxActive:0,aborts:0,cancels:0});process.send({id:job.id,result:true}); }
  if (job.action === 'credential') {
    const arch=path.join(AUTHS_DIR,stableAccountId(cred.session()));
    new CredentialManager(arch).applyNewAuth({accessToken:'new-synthetic-access',refreshToken:'new-synthetic-refresh',expiresIn:3600});
    process.send({id:job.id,result:{archiveUpdated:JSON.parse(fs.readFileSync(arch)).auth.accessToken==='new-synthetic-access',activeUpdated:cred.session().auth.accessToken==='new-synthetic-access'}});
  }
  if (job.action === 'abortBridge') {const a=new AbortController();const h=withHeadersTimeout(a.signal);h.clear();a.abort();process.send({id:job.id,result:{parentAborted:a.signal.aborted,upstreamAborted:h.signal.aborted}});}
  if (job.action === 'schedule') {
    const tick=backupTick;
    const ActualDate=Date, original=runAutoBackup;let calls=0,clock=0;
    global.Date=class extends ActualDate {constructor(...a){super(...(a.length?a:[clock]));}static now(){return clock;}};
    runAutoBackup=()=>{calls++;checkinState.autoBackup={at:Date.now()};return {ok:true}};checkinState.autoBackup=null;
    const counts={};
    for (const at of ['05:30','05:55']) {appSettings.backupAt=at;calls=0;checkinState.autoBackup=null;for(let m=2;m<1440;m+=10){clock=new ActualDate(2026,8,27,0,m).getTime();tick();}counts[at]=calls;}
    global.Date=ActualDate;runAutoBackup=original;process.send({id:job.id,result:{tickMinutePhase:2,executions:counts}});
  }
});
`;
  mod._compile(fs.readFileSync(file, 'utf8') + instrumentation, file);
} else {
  (async () => {
    const root = path.resolve(__dirname, '../..');
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-audit-'));
    fs.mkdirSync(path.join(sandbox,'backend')); for (const name of fs.readdirSync(path.join(root,'backend')).filter(n=>n.endsWith('.cjs'))) fs.copyFileSync(path.join(root,'backend',name), path.join(sandbox,'backend',name));
    fs.copyFileSync(path.join(root,'backend','project-version.json'), path.join(sandbox,'backend','project-version.json'));
    fs.copyFileSync(path.join(root,'server.js'), path.join(sandbox,'server.cjs'));
    fs.copyFileSync(path.join(root,'admin.html'), path.join(sandbox,'admin.html'));
    fs.mkdirSync(path.join(sandbox,'auths'));
    fs.writeFileSync(path.join(sandbox,'auth.json'),JSON.stringify({account:{uid:'audit0012345678',nickname:'Synthetic audit account'},auth:{domain:'www.workbuddy.cn',accessToken:'old-synthetic-access',refreshToken:'old-synthetic-refresh',expiresAt:Date.now()+3600000}}));
    fs.writeFileSync(path.join(sandbox,'.api-keys.json'),JSON.stringify([{key:'share-audit-only',name:'Audit',dailyLimit:1,models:[],accounts:[]}])) ;
    const child=fork(__filename,['--child'],{cwd:sandbox,env:{...process.env,AUDIT_SANDBOX:sandbox,HOST:'127.0.0.1',PORT:'0',CB_API_KEY:'master-audit-only',CB_AUTH_FILE:path.join(sandbox,'auth.json'),LOCALAPPDATA:sandbox,XDG_DATA_HOME:sandbox,CB_ACCT_MAX_INFLIGHT:'2',CB_UPSTREAM_STREAM_IDLE:'50',CB_REQ_BUDGET_MS:'1000',CB_STREAM_MAX_MS:'1200',CB_MAX_BODY_MB:'1'},stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
    let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
    let seq=0;
    const rpc=action=>new Promise((resolve,reject)=>{const id=++seq;const t=setTimeout(()=>{child.off('message',listener);reject(Error('RPC timeout'));},3000);const listener=m=>{if(m.id===id){clearTimeout(t);child.off('message',listener);resolve(m.result)}};child.on('message',listener);child.send({id,action})});
    const results={};
    try {
      const port=await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('Startup timeout')),5000);child.on('message',m=>{if(m.ready){clearTimeout(t);resolve(m.port)}});child.on('exit',code=>reject(Error('Audit process exited '+code)))});
      const base='http://127.0.0.1:'+port;
      await rpc('slowModels');
      const fastStatus=await fetch(base+'/admin/api/status?detail=light&key=master-audit-only',{signal:AbortSignal.timeout(3000+timingAllowance)});
      assert.equal(fastStatus.status,200);assert.ok((await fastStatus.json()).service.models.length);
      await rpc('restoreModels');results.fastStartup={statusDoesNotWaitForModels:true};
      const chat=(model,key='master-audit-only',signal)=>fetch(base+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:'audit'}],stream:true}),signal:signal||AbortSignal.timeout(10000+timingAllowance)});
      const drain=async r=>({status:r.status,body:await r.text()});
      await Promise.all(Array.from({length:5},()=>chat('audit-concurrency').then(drain)));
      let snap=await rpc('snapshot');
      results.concurrency={configured:2,observed:snap.audit.maxActive,reportedLeases:snap.leases};
      assert.equal(snap.audit.maxActive,2);assert.deepEqual(snap.leases,{});
      await rpc('reset');
      const quota=await Promise.all([chat('audit-quota','share-audit-only').then(drain),chat('audit-quota','share-audit-only').then(drain)]);
      snap=await rpc('snapshot');results.quota={configured:1,http:quota.map(r=>r.status),recorded:snap.keyUsage.requests};assert.equal(snap.keyUsage.requests,1);assert.deepEqual(quota.map(r=>r.status).sort(),[200,429]);
      await rpc('reset');
      const started=performance.now();await drain(await chat('audit-idle'));results.idle={configuredMs:50,completedAfterMs:Math.round(performance.now()-started)};assert.ok(results.idle.completedAfterMs<350+timingAllowance);
      await rpc('reset');
      const ctl=new AbortController();const disconnected=await chat('audit-disconnect','master-audit-only',ctl.signal);await disconnected.body.getReader().read();ctl.abort();await sleep(90);
      snap=await rpc('snapshot');results.disconnect={upstreamStillActive:snap.audit.active,upstreamAborts:snap.audit.aborts,readerCancels:snap.audit.cancels};assert.equal(snap.audit.active,0);await sleep(500);
      const errorsBefore=(await rpc('snapshot')).errors;
      const errorResponse=await drain(await chat('audit-stream-error'));snap=await rpc('snapshot');results.streamError={clientReceivedError:errorResponse.body.includes('stream interrupted'),errorCounterIncrement:snap.errors-errorsBefore,requestErrorRecorded:!!snap.last.err};assert.equal(results.streamError.clientReceivedError,true);assert.equal(results.streamError.errorCounterIncrement,1);assert.equal(results.streamError.requestErrorRecorded,true);
      results.credentialSync=await rpc('credential');assert.deepEqual(results.credentialSync,{archiveUpdated:true,activeUpdated:true});
      results.abortBridge=await rpc('abortBridge');assert.deepEqual(results.abortBridge,{parentAborted:true,upstreamAborted:true});
      results.backupSchedule=await rpc('schedule');assert.equal(results.backupSchedule.executions['05:55'],1);
      const light = await (await fetch(base+'/admin/api/status?detail=light&key=master-audit-only')).json();
      assert.ok(!('usage' in light));
      const usage = await (await fetch(base+'/admin/api/usage?key=master-audit-only')).json();assert.ok(usage.ok && usage.usage);
      const full = await (await fetch(base+'/admin/api/status?key=master-audit-only')).json();assert.ok(full.usage);
      results.status = {lightHasNoHistory:true, legacyStatusCompatible:true};
      const admin = async (route, body) => {
        const r=await fetch(base+'/admin/api'+route+'?key=master-audit-only',{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
        return {status:r.status,data:await r.json()};
      };
      for (const endpoint of ['/request-map','/request-map/live']) assert.equal((await fetch(base+'/admin/api'+endpoint+'?key=share-audit-only')).status,401);
      const named=(await admin('/keys/create',{name:'Map identity test'})).data;
      const namedResponse=await chat('audit-budget',named.key);
      const activeMap=(await admin('/request-map')).data;
      assert.equal(activeMap.requests.length,1);assert.equal(activeMap.requests[0].keyName,'Map identity test');assert.equal(activeMap.requests[0].keyMasked,named.key.slice(0,5)+'…'+named.key.slice(-4));assert.ok(!JSON.stringify(activeMap).includes(named.key));
      await drain(namedResponse);assert.equal((await admin('/request-map')).data.requests.length,0);
      results.requestMap={masterOnly:true,nativeLifecycle:true,exactKeyIdentity:true,maskedOnly:true};
      results.optimizations=await rpc('optimizationChecks');
      assert.deepEqual(results.optimizations,{credentialReads:0,credentialStats:0,slowDisconnected:true,inflightFlushed:true});
      const huge=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer master-audit-only'},body:'x'.repeat(1024*1024+1)});
      assert.equal(huge.status,413);assert.match((await huge.json()).error.message,/上限/);results.optimizations.bodyLimit413=true;
      const chunked=await fetch(base+'/v1/chat/completions',{method:'POST',duplex:'half',headers:{Authorization:'Bearer master-audit-only'},body:new ReadableStream({start(c){c.enqueue(new Uint8Array(800000));c.enqueue(new Uint8Array(800000));c.close();}})});
      assert.equal(chunked.status,413);await chunked.text();
      await drain(await chat('audit-words-success'));assert.equal((await rpc('snapshot')).last.filter,false);
      await drain(await chat('audit-filter-success'));assert.equal((await rpc('snapshot')).last.filter,true);results.optimizations.structuredFilter=true;
      const restricted=(await admin('/keys/create',{name:'Restricted fallback',models:['claude-audit-unavailable']})).data;
      const blockedFallback=await chat('claude-audit-unavailable',restricted.key);
      assert.equal(blockedFallback.status,200);assert.equal(blockedFallback.headers.get('x-fallback-model'),null);assert.match(await blockedFallback.text(),/model not found/);
      const fallback=await chat('claude-audit-unavailable');assert.equal(fallback.status,200);assert.equal(fallback.headers.get('x-fallback-model'),'hy4-preview');assert.equal(fallback.headers.get('x-original-model'),'claude-audit-unavailable');await drain(fallback);results.optimizations.fallbackRespectsModelPermissions=true;

      const aggregated=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer master-audit-only','Content-Type':'application/json'},body:JSON.stringify({model:'audit-success',messages:[{role:'user',content:'hello'}]})});
      assert.equal(aggregated.status,200);assert.equal((await aggregated.json()).choices[0].message.content,'A');
      await rpc('adapters');const adapterResults=[];
      for (const type of ['custom','opencode','trae','qoder']) {
        const saved=await admin('/ext/save',{type,name:type,prefix:type,baseUrl:'https://synthetic.invalid/v1',models:['success','idle','stream-error','budget']});assert.equal(saved.status,200);
        const good=await drain(await chat(type+'/success'));assert.equal(good.status,200);assert.ok(good.body.includes('[DONE]'));
        const errBefore=(await rpc('snapshot')).errors;
        const bad=await drain(await chat(type+'/stream-error'));assert.ok(bad.body.includes('stream interrupted'));
        assert.equal((await rpc('snapshot')).errors,errBefore+1);
        await rpc('reset');const ctl=new AbortController();const r=await chat(type+'/idle','master-audit-only',ctl.signal);await r.body.getReader().read();ctl.abort();await sleep(70);assert.equal((await rpc('snapshot')).audit.active,0);
        const start=performance.now();const pending=await chat(type+'/budget');
        const map=(await admin('/request-map')).data;assert.equal(map.requests.length,1);assert.equal(map.requests[0].model,type+'/budget');assert.equal(map.requests[0].keyName,'主密钥');assert.equal(map.requests[0].keyMasked,'maste…only');
        const budget=await drain(pending);assert.ok(budget.body.includes('upstream timeout'));assert.equal((await rpc('snapshot')).last.outcome,'timeout');assert.ok(performance.now()-start<1800+timingAllowance);assert.equal((await admin('/request-map')).data.requests.length,0);
        adapterResults.push({type,stream:true,errorAccounting:true,cancellation:true,streamDurationCap:true});
      }
      results.adapters=adapterResults;
      const startedBudget=performance.now();await drain(await chat('audit-budget'));assert.ok(performance.now()-startedBudget<1800+timingAllowance);assert.equal((await rpc('snapshot')).audit.active,0);
      const beforeKeys=(await admin('/keys')).data.keys;
      await rpc('diskFail');
      assert.equal((await admin('/request-map/settings',{enabled:false})).status,503);
      assert.equal((await admin('/request-map')).data.enabled,true);
      const failed=await admin('/keys/create',{name:'must-not-exist'});assert.equal(failed.status,503);
      assert.deepEqual((await admin('/keys')).data.keys,beforeKeys);
      const oldName=beforeKeys[0].name;
      assert.equal((await admin('/keys/update',{id:beforeKeys[0].id,name:'must-not-change'})).status,503);
      assert.equal((await admin('/keys')).data.keys[0].name,oldName);
      await rpc('diskRecover');
      assert.equal((await admin('/request-map/settings',{enabled:'no'})).status,400);
      assert.equal((await admin('/request-map/settings',{enabled:false})).data.enabled,false);
      assert.equal((await admin('/request-map')).data.enabled,false);
      assert.equal(JSON.parse(fs.readFileSync(path.join(sandbox,'settings.json'))).requestMapEnabled,false);
      assert.equal((await admin('/status')).data.settings.requestMapEnabled,false);
      assert.equal((await admin('/request-map/settings',{enabled:true})).data.enabled,true);
      results.requestMap.persistedSwitch=true;
      assert.equal((await admin('/keys/update',{id:beforeKeys[0].id,name:oldName})).status,200);
      const providers=(await admin('/ext/list')).data.providers;
      const original=providers[0];
      const invalid=await admin('/ext/save',{...original,prefix:'INVALID PREFIX',name:'invalid-change'});assert.equal(invalid.status,400);
      assert.equal((await admin('/ext/list')).data.providers[0].name,original.name);
      results.persistence={createFailure503:true,updateFailure503:true,inMemoryRollback:true,invalidProviderRollback:true};
      const compressed=await fetch(base+'/admin?key=master-audit-only',{headers:{'Accept-Encoding':'br'}});assert.equal(compressed.headers.get('content-encoding'),'br');assert.ok((await compressed.text()).includes('<html'));
      results.compression={brotliRoundTrip:true};
      const exited=new Promise(resolve=>child.once('exit',resolve));child.send({action:'fatal'});assert.equal(await exited,1);results.fatalExit={exitCode:1};
      results.safety={realUpstreamRequests:0,isolatedSandbox:true};
      const text=JSON.stringify(results,null,2);fs.writeFileSync(path.join(root,'backend-review','regression-results.json'),text+'\n');console.log(text);
    } catch (e) { console.error(logs); throw e; } finally {
      if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}
      const verified=path.resolve(sandbox);assert.equal(path.dirname(verified),path.resolve(os.tmpdir()));assert.ok(path.basename(verified).startsWith('workbuddy-audit-'));
      fs.rmSync(verified,{recursive:true,force:true});
    }
  })().catch(e=>{console.error(e);process.exitCode=1});
}

