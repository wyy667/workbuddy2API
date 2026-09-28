const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRequestMap, maskMapKey } = require('../request-map.cjs');
const { createRequestMapController } = require('../request-map.cjs');
const { normalize, publicIP, clientIP } = require('../geo-ip.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const makeGeo = () => ({ status:{ready:true}, lookup:async ip=>publicIP(ip)?{country:'中国',region:'四川省',label:'中国 · 四川省',lat:31,lon:104,precision:'省 / 州级估算'}:null,close(){} });
function request(ip='8.8.8.8') { const ctl=new AbortController();return {socket:{remoteAddress:ip},headers:{},scope:{signal:ctl.signal},ctl}; }
class Response extends EventEmitter { writeHead(status,headers){this.status=status;this.headers=headers;} write(data){this.data=(this.data||'')+data;return true;} end(){this.emit('close');} destroy(){this.destroyed=true;this.emit('close');} }

test('map masks short keys and preserves identity when tails collide',async()=>{
  assert.equal(maskMapKey('abcdefghijklmnop'),'abcde…mnop');assert.equal(maskMapKey('short'),'••••…rt');assert.equal(maskMapKey('xy'),'••••');
  const map=createRequestMap({geo:makeGeo(),originIP:'220.167.103.215'});await map.ready;
  const a=request(),b=request(),ra=new Response(),rb=new Response();
  const endA=map.begin(a,ra,{key:'sk-first-0000',name:'A'},{model:'deepseek',stream:true});
  map.begin(b,rb,{key:'sk-other-0000',name:'B'},{model:'kimi'});await tick();
  assert.deepEqual(map.snapshot().requests.map(r=>r.keyName),['A','B']);
  const encoded=JSON.stringify(map.snapshot());assert.ok(!encoded.includes('sk-first-0000'));assert.ok(!encoded.includes('sk-other-0000'));assert.ok(!encoded.includes('token'));
  endA();endA();assert.equal(map.snapshot().requests.length,1);rb.emit('finish');assert.equal(map.snapshot().requests.length,0);map.close();
});
test('all cancellation paths remove immediately and late geo results cannot resurrect requests',async()=>{
  let finish;const geo=makeGeo();const map=createRequestMap({geo,originIP:'220.167.103.215'});await map.ready;
  geo.lookup=()=>new Promise(resolve=>{finish=resolve});
  for(const event of ['abort','close','finish','finally']) {
    const req=request(),res=new Response();const end=map.begin(req,res,{admin:true},{model:'hy',stream:true},'master-secret-value');
    assert.equal(map.snapshot().requests[0].keyName,'主密钥');
    if(event==='abort')req.ctl.abort();else if(event==='finally')end();else res.emit(event);
    assert.equal(map.snapshot().requests.length,0);finish({lat:31,lon:104});await tick();assert.equal(map.snapshot().requests.length,0);
    assert.equal(res.listenerCount('close'),0);assert.equal(res.listenerCount('finish'),0);
  }
  map.close();
});
test('IPv4, IPv6 and explicit trusted proxy chain reject forged forwarding',()=>{
  assert.equal(normalize('::ffff:8.8.8.8'),'8.8.8.8');
  for(const ip of ['127.0.0.1','10.1.1.1','172.16.2.1','192.168.1.1','169.254.2.1','100.64.1.1','::1','fc00::1','fe80::1','invalid']) assert.equal(publicIP(ip),false,ip);
  assert.equal(publicIP('2001:4860:4860::8888'),true);
  const req=request('8.8.8.8');req.headers['x-forwarded-for']='1.1.1.1';assert.equal(clientIP(req,[]),'8.8.8.8');
  req.socket.remoteAddress='127.0.0.1';req.headers['x-forwarded-for']='6.6.6.6, 1.1.1.1, 10.0.0.2';
  assert.equal(clientIP(req,['127.0.0.1/32','10.0.0.0/8']),'1.1.1.1');
  req.headers['x-forwarded-for']='1.1.1.1, invalid';assert.equal(clientIP(req,['127.0.0.1/32']),'127.0.0.1');
});
test('SSE starts with authoritative snapshot, monotonic changes and bounded consumers',async()=>{
  const map=createRequestMap({geo:makeGeo(),originIP:'220.167.103.215'});await map.ready;
  const req=request(),res=new Response();const end=map.begin(req,res,{key:'abc'},{model:'glm'});await tick();
  const client=new Response();map.subscribe({},client);
  let events=client.data.trim().split('\n\n').map(x=>JSON.parse(x.slice(6)));assert.equal(events[0].type,'snapshot');assert.equal(events[0].requests.length,1);
  end();events=client.data.trim().split('\n\n').map(x=>JSON.parse(x.slice(6)));assert.equal(events.at(-1).type,'remove');assert.ok(events.at(-1).seq>events[0].seq);
  client.writableLength=300000;map.begin(request(),new Response(),{key:'def'},{model:'kimi'});assert.equal(client.destroyed,true);map.close();
});
test('128 active requests clear without accumulating listeners or private location fabrications',async()=>{
  const map=createRequestMap({geo:makeGeo(),originIP:'220.167.103.215'});await map.ready;
  const ends=Array.from({length:128},()=>map.begin(request('127.0.0.1'),new Response(),{}, {model:'test'}));await tick();
  assert.equal(map.snapshot().requests.length,128);assert.ok(map.snapshot().requests.every(r=>r.location===null));
  for(const end of ends)end();assert.equal(map.snapshot().requests.length,0);map.close();
});
test('missing local database reports degraded state without any network or request failure',async()=>{
  const {Worker}=require('node:worker_threads');const path=require('node:path');
  const worker=new Worker(path.resolve(__dirname,'../geo-worker.cjs'),{workerData:{file:path.resolve(__dirname,'missing-test-database.mmdb'),autoUpdate:false}});
  try{
    const message=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});
    assert.equal(message.type,'status');assert.equal(message.status.ready,false);assert.ok(message.status.error);
    const reply=new Promise(resolve=>worker.once('message',resolve));worker.postMessage({type:'lookup',id:1,ip:'8.8.8.8'});assert.equal((await reply).location,null);
  }finally{await worker.terminate();}
});
test('global switch disables tracking, ends subscribers and waits for locator disposal',async()=>{
  let disposed=false;const geo=makeGeo();geo.close=async()=>{await tick();disposed=true;};
  const map=createRequestMapController({enabled:false,engineOptions:{geo,originIP:'220.167.103.215'}});
  assert.equal(map.snapshot().enabled,false);assert.equal(map.begin(request(),new Response(),{},{model:'ignored'}),undefined);
  await map.setEnabled(true);const end=map.begin(request(),new Response(),{},{model:'active'});await tick();assert.equal(map.snapshot().requests.length,1);
  const client=new Response();map.subscribe({},client);let closed=false;client.on('close',()=>closed=true);
  await map.setEnabled(false);assert.equal(disposed,true);assert.equal(closed,true);assert.ok(client.data.includes('"type":"disabled"'));assert.equal(map.snapshot().requests.length,0);assert.equal(map.snapshot().enabled,false);end();map.close();
});
