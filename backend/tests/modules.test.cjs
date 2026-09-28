'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const zlib = require('node:zlib');
const runtime = require('../request.cjs');
const { createQuotaLedger, keyId, resolveKey } = require('../quota.cjs');
const { scheduledDue } = require('../schedule.cjs');
const { createCompression, pickCompression } = require('../compression.cjs');
const { createPersistence } = require('../persistence.cjs');
const { syncCredentialCopies, identity } = require('../credentials.cjs');

test('quota reserves before dispatch, refunds unstarted requests and settles once', () => {
  let day = '2026-09-27'; const ledger = createQuotaLedger(() => day);
  const entry = { dailyLimit: 1 }, a = { restrictions: entry }, b = { restrictions: entry };
  assert.equal(ledger.reserve(a, 'auto'), null);
  assert.equal(ledger.reserve(b, 'auto').status, 429);
  assert.equal(ledger.settle(a), false);
  assert.equal(ledger.reserve(b, 'auto'), null); b.reservation.started = true;
  assert.equal(ledger.settle(b, 8, 1.2), true); assert.equal(ledger.settle(b, 8, 1.2), false);
  assert.deepEqual(entry.usage, { date: day, requests: 1, tokens: 8, credit: 1.2 });
  day = '2026-09-28'; assert.equal(ledger.reserve({restrictions: entry}, 'auto'), null);
});
test('settlement thresholds serialize limited keys, model allowlists remain enforced', () => {
  const ledger = createQuotaLedger(()=>'today'), e = {dailyTokenLimit:10,models:['ok']};
  assert.equal(ledger.reserve({restrictions:e}, 'wrong').status,403);
  const a={restrictions:e}; assert.equal(ledger.reserve(a,'ok'),null);
  assert.equal(ledger.reserve({restrictions:e},'ok').status,429);
  a.reservation.started=true; ledger.settle(a,12);
  assert.equal(ledger.reserve({restrictions:e},'ok').status,429);
});
test('key identities remain stable and legacy suffix collisions are rejected', () => {
  const a={key:'secret-a-1234'}, b={key:'secret-b-1234'};
  assert.notEqual(keyId(a),keyId(b)); assert.equal(keyId({...a}),keyId(a));
  assert.throws(()=>resolveKey([a,b],{tail:'1234'}),e=>e.status===409);
  assert.equal(resolveKey([a,b],{id:keyId(b)}),b);
});
test('scheduler catches missed minute windows, obeys calendar periods and deduplicates', () => {
  const date=(d,h,m)=>new Date(2026,8,d,h,m);
  assert.equal(scheduledDue(date(27,6,2),'05:55',null),true);
  assert.equal(scheduledDue(date(27,6,2),'05:55',+date(27,6,0)),false);
  assert.equal(scheduledDue(date(27,6,2),'5:55',+date(25,23,0),2),true);
  assert.equal(scheduledDue(date(27,5,54),'05:55',null),false);
  assert.equal(scheduledDue(date(27,7,0),'29:99',null),false);
});
test('header timer cleanup preserves cancellation of response body', () => {
  const parent=new AbortController(), headers=runtime.withHeadersTimeout(parent.signal,1000);
  headers.clear(); parent.abort(runtime.cancelled?.() || new Error('cancelled'));
  assert.equal(headers.signal.aborted,true);
});
test('idle and client abort reject, never masquerade as normal EOF', async () => {
  for (const mode of ['idle','abort']) {
    let cancelled=0;
    const reader=new ReadableStream({cancel(){cancelled++;}}).getReader();
    const ctl=new AbortController();
    const read=runtime.readWithIdle(reader,20,ctl.signal);
    if(mode==='abort') ctl.abort(new Error('explicit cancellation'));
    await assert.rejects(read, mode==='abort'?/explicit cancellation/:/idle timeout/);
    assert.equal(cancelled,1);
  }
});
test('backpressure waits for drain and removes listeners on cancellation', async () => {
  const res=new EventEmitter(); res.write=()=>false;
  const ctl=new AbortController(); let done=false;
  const write=runtime.writeChunk(res,'chunk',ctl.signal).then(()=>done=true);
  await Promise.resolve(); assert.equal(done,false); res.emit('drain'); await write;
  assert.equal(res.listenerCount('close'),0);
  const wait=runtime.writeChunk(res,'chunk',ctl.signal);ctl.abort(new Error('cancel'));
  await assert.rejects(wait,/cancel/);assert.equal(res.listenerCount('drain'),0);
});
test('compression uses valid cached encodings and negotiates q values', async () => {
  const html='<html>'+('test content '.repeat(10000))+'</html>', c=createCompression(html), input=Buffer.from(html);
  const [one,two]=await Promise.all([c.pack(input,'br'),c.pack(input,'br')]);
  assert.equal(one,two);assert.equal(zlib.brotliDecompressSync(one).toString(),html);
  const dynamic=Buffer.from(JSON.stringify({a:'x'.repeat(2000)}));
  assert.deepEqual(zlib.gunzipSync(await c.pack(dynamic,'gzip')),dynamic);
  assert.equal(pickCompression({'accept-encoding':'br;q=0, gzip;q=0.5'}),'gzip');
  assert.equal(pickCompression({'accept-encoding':'br;q=0,gzip;q=0,*;q=1'}),null);
});
test('atomic write failures preserve old data, report health and clear after recovery', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-persist-'));const file=path.join(dir,'settings.json');
  const logs=[], store=createPersistence(s=>logs.push(s));
  try {
    store.write(file,{version:1});
    const rename=fs.renameSync;
    try { fs.renameSync=()=>{const e=new Error('disk fault');e.code='ENOSPC';throw e;};
      assert.throws(()=>store.write(file,{version:2}),e=>e.status===503);
      assert.throws(()=>store.write(file,{version:3}),e=>e.status===503);
    } finally { fs.renameSync=rename; }
    assert.equal(JSON.parse(fs.readFileSync(file)).version,1);assert.equal(logs.length,1);
    assert.equal(store.status()[0].count,2);assert.deepEqual(fs.readdirSync(dir),['settings.json']);
    store.write(file,{version:4});assert.deepEqual(store.status(),[]);
  } finally {fs.unlinkSync(file);fs.rmdirSync(dir);}
});
test('credential refresh reconciles matching copies without overwriting switched account', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-identity-'));
  const active=path.join(dir,'auth.json'),archive=path.join(dir,'a.json');
  const old={account:{uid:'samepref-full-a'},auth:{domain:'cn',accessToken:'old'}};
  const next={...old,auth:{domain:'cn',accessToken:'new'}};
  const other={account:{uid:'samepref-full-b'},auth:{domain:'cn',accessToken:'other'}};
  const identify=s=>identity(s,x=>x),write=(f,v)=>fs.writeFileSync(f,JSON.stringify(v));
  try {
    write(active,other);write(archive,old);
    syncCredentialCopies({fs,path,session:next,originalFile:active,archiveFile:archive,activeFile:active,write,identify,report:()=>{}});
    assert.deepEqual(JSON.parse(fs.readFileSync(active)),other);assert.deepEqual(JSON.parse(fs.readFileSync(archive)),next);
    write(active,old);
    syncCredentialCopies({fs,path,session:next,originalFile:archive,archiveFile:archive,activeFile:active,write,identify,report:()=>{}});
    assert.equal(JSON.parse(fs.readFileSync(active)).auth.accessToken,'new');
  } finally {fs.unlinkSync(active);fs.unlinkSync(archive);fs.rmdirSync(dir);}
});
