'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createRequestScope,splitLines}=require('../request.cjs');
const {createPersistence}=require('../persistence.cjs');

test('streaming replaces admission deadline once, retains hard cap and disconnect cancellation',()=>{
 const originalSet=global.setTimeout,originalClear=global.clearTimeout;
 const timers=new Map();let id=0;
 global.setTimeout=(fn,ms)=>{timers.set(++id,{fn,ms});return id;};global.clearTimeout=i=>timers.delete(i);
 try {
  const req=new EventEmitter(),res=new EventEmitter();
  const scope=createRequestScope(req,res,100,1000);
  assert.equal([...timers.values()][0].ms,100);
  scope.streaming();scope.streaming();
  assert.equal(timers.size,1);assert.equal([...timers.values()][0].ms,1000);
  [...timers.values()][0].fn();assert.equal(scope.signal.reason.requestTimeout,true);
  scope.finish();assert.equal(timers.size,0);assert.equal(res.listenerCount('close'),0);
  const unlimited=createRequestScope(req,res,100,0);unlimited.streaming();assert.equal(timers.size,0);
  res.emit('close');assert.equal(unlimited.signal.reason.clientCancelled,true);unlimited.finish();
  const waiting=createRequestScope(req,res,100,1000);[...timers.values()][0].fn();waiting.streaming();
  assert.match(waiting.signal.reason.message,/budget/);waiting.finish();
 } finally {global.setTimeout=originalSet;global.clearTimeout=originalClear;}
});

test('async persistence snapshots values and cannot overwrite a newer synchronous save',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-opt-')),file=path.join(dir,'usage.json');
 const store=createPersistence(()=>{}),original=fs.promises.writeFile;
 t.after(()=>{fs.promises.writeFile=original;assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});});
 let release,entered;
 const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 fs.promises.writeFile=async(...args)=>{entered();await gate;return original.apply(fs.promises,args);};
 const old={n:1};const pending=store.writeAsync(file,old);old.n=99;
 await started;store.write(file,{n:2});release();await pending;
 assert.deepEqual(JSON.parse(fs.readFileSync(file)),{n:2});
 fs.promises.writeFile=original;
 const value={n:3};const latest=store.writeAsync(file,value);value.n=100;await latest;
 assert.equal(fs.readFileSync(file,'utf8'),'{"n":3}');
 await Promise.all([store.writeAsync(file,{n:4}),store.writeAsync(file,{n:5})]);
 await store.drain();assert.deepEqual(JSON.parse(fs.readFileSync(file)),{n:5});
 assert.deepEqual(fs.readdirSync(dir),['usage.json']);
});

test('splitLines preserves chunk tails and CRLF for SSE parsing',()=>{
 const lines=[];let tail=splitLines('data: one\r\ndata: tw',l=>lines.push(l));
 tail=splitLines(tail+'o\n\ndata: three',l=>lines.push(l));
 assert.deepEqual(lines,['data: one\r','data: two','']);assert.equal(tail,'data: three');
});
