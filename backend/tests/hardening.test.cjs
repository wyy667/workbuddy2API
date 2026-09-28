'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const {normalizeBase,parseReset,validateBackup}=require('../hardening.cjs');
const source=fs.readFileSync(path.join(__dirname,'../../server.js'),'utf8');
function slice(start,end){return source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));}
test('reset timestamps use upstream timezone independent of host; explicit offsets survive',()=>{
 const prev=process.env.TZ;try{for(const zone of ['UTC','Asia/Shanghai','America/New_York']){process.env.TZ=zone;assert.equal(parseReset('2026-09-28 12:00:00'),Date.parse('2026-09-28T04:00:00Z'));}}finally{if(prev===undefined)delete process.env.TZ;else process.env.TZ=prev;}
 assert.equal(parseReset('2026-09-28T12:00:00Z'),Date.parse('2026-09-28T12:00:00Z'));
 assert.equal(parseReset('2026-02-31 12:00:00',100),3600100);
});
test('provider URLs default to TLS, allow explicit local HTTP, reject credential and metadata URLs',()=>{
 assert.equal(normalizeBase('example.com/'),'https://example.com/v1');
 assert.equal(normalizeBase('http://127.0.0.1:8080'),'http://127.0.0.1:8080/v1');
 for(const x of ['http://example.com','https://a:b@example.com','file:///a','http://169.254.169.254','https://example.com?q=key','https://example.com/#a'])assert.throws(()=>normalizeBase(x));
});
test('backup validates every account and configuration before restore, accepts legacy bundles',()=>{
 const account={account:{uid:'1'},auth:{accessToken:'synthetic'}};
 const base={accounts:{'one.json':account},active:account};assert.equal(validateBackup(base),base);
 for(const patch of [{accounts:[]},{accounts:{'../one.json':account}},{accounts:{'one.json':account,'two.json':{auth:{}}}},{apiKeys:[{key:'a',models:'*'}]},{rotation:{enabled:true,intervalMin:1}},{settings:{requestMapEnabled:'false'}},{extProviders:[{id:'x',prefix:'x',baseUrl:'http://example.com'}]}])assert.throws(()=>validateBackup({...base,...patch}));
 assert.throws(()=>validateBackup(JSON.parse('{"accounts":{},"settings":{"__proto__":{}}}')));
});
test('backup commit failure rolls back earlier files and leaves no staging artifacts',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-batch-'));const a=path.join(dir,'a.json'),b=path.join(dir,'b.json');
 fs.writeFileSync(a,'{"old":1}');fs.writeFileSync(b,'{"old":2}');const rename=fs.renameSync;let failed=false;
 try {
  fs.renameSync=(from,to)=>{if(to===b&&!failed){failed=true;throw Error('synthetic disk failure');}return rename(from,to);};
  const store=require('../persistence.cjs').createPersistence(()=>{});
  assert.throws(()=>store.writeBatch([[a,{new:1}],[b,{new:2}]]));
  assert.equal(fs.readFileSync(a,'utf8'),'{"old":1}');assert.equal(fs.readFileSync(b,'utf8'),'{"old":2}');assert.equal(fs.readdirSync(dir).length,2);
 }finally{fs.renameSync=rename;fs.rmSync(dir,{recursive:true,force:true});}
});
test('custom model test sends request without chat-only ctx',async()=>{
 let calls=0;const c={extUpstreamName:(_,x)=>x,AbortSignal,Date,TextDecoder,BUILTIN_EXT:{},sanitizeRemoteText:String,UPSTREAM_STREAM_IDLE_MS:100,readWithIdle:require('../request.cjs').readWithIdle,extNormUsage:x=>x,
 fetch:async()=>{calls++;return new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');}};
 vm.createContext(c);vm.runInContext(slice('async function extTestModel(','\n//'),c);
 const out=await c.extTestModel({type:'custom',baseUrl:'https://example.invalid'},'test');assert.equal(out.ok,true,JSON.stringify(out));assert.equal(calls,1);
});
test('Qoder renders fresh placeholders and check-in coalesces in-flight account calls',async()=>{
 const c={crypto,Buffer,Date,require:()=>require('../../ext-assets.js'),sanitizeRemoteText:String};vm.createContext(c);vm.runInContext(slice('let _qoderTemplate = null;','function qoderMd5('),c);
 const a=c.qoderTemplate(),b=c.qoderTemplate();assert.notEqual(a.request_id,b.request_id);assert.notEqual(a.business.id,b.business.id);
 let finish,calls=0;const d={path,checkinFileOnce:()=>{calls++;return new Promise(r=>finish=r);}};vm.createContext(d);vm.runInContext(slice('const checkinFlights = new Map();','async function checkinFileOnce('),d);
 const p=d.checkinFile('a.json'),q=d.checkinFile('a.json');assert.equal(p,q);assert.equal(calls,1);finish({ok:true});await p;
 const next=d.checkinFile('a.json');assert.equal(calls,2);finish({ok:true});await next;
});

test('scheduled and manual check-in batches share the same gate',async()=>{
 let tick,release,calls=0;const c={checkinRunning:false,CHECKIN_AT:'00:00',Date,fs:{mkdirSync(){},readdirSync:()=>['a.json'],readFileSync:()=>'{"account":{"uid":"a"}}'},AUTHS_DIR:'test',path,checkinState:{accounts:{}},todayStr:()=> '2026-09-27',uid8Of:()=> 'a',is403Flagged:()=>false,log(){},saveCheckinState(){},sanitizeRemoteText:String,runDailyExtras:async()=>{},checkinFile:()=>{calls++;return new Promise(r=>release=r);},setInterval:fn=>{tick=fn;return {unref(){}};}};
 vm.createContext(c);vm.runInContext(slice('async function runDailyCheckinAll()','function parseMaybeMs('),c);
 const pending=tick();assert.equal(calls,1);await tick();assert.equal(calls,1);assert.equal((await c.runDailyCheckinAll()).ok,false);release({ok:true});await pending;assert.equal(c.checkinRunning,false);
});
