'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const http=require('node:http');
const {EventEmitter}=require('node:events');
const createDispatcher=require('../http-dispatcher.cjs');
const {createRequestScope,withHeadersTimeout,readWithIdle}=require('../request.cjs');

test('ten-minute waiting and idle deadlines survive earlier limits and still expire',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const scope=createRequestScope(new EventEmitter(),new EventEmitter(),600000,1800000);
 const head=withHeadersTimeout(scope.signal,600000);
 t.mock.timers.tick(599999);assert.equal(head.signal.aborted,false);
 t.mock.timers.tick(1);assert.equal(head.signal.aborted,true);scope.finish();head.clear();
 let cancelled=false;
 const waiting=readWithIdle({read:()=>new Promise(()=>{}),cancel(){cancelled=true;}},600000);
 const rejected=assert.rejects(waiting,/idle timeout/);
 t.mock.timers.tick(599999);assert.equal(cancelled,false);
 t.mock.timers.tick(1);await rejected;assert.equal(cancelled,true);
});

test('real native fetch accepts delayed headers and silent SSE through bundled dispatcher',async()=>{
 const delay=Number(process.env.WB_LONG_WAIT_MS||60);
 const dispatcher=createDispatcher();
 const server=http.createServer((req,res)=>{
  const timer=setTimeout(()=>res.end('data: done\n\n'),delay);
  if(req.url==='/body'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();res.write(': connected\n\n');}
  res.on('close',()=>clearTimeout(timer));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {
  const base='http://127.0.0.1:'+server.address().port;
  await Promise.all(['/headers','/body'].map(async route=>{
   const scope=createRequestScope(new EventEmitter(),new EventEmitter(),600000,1800000);
   const header=withHeadersTimeout(scope.signal,600000);
   try {
    const response=await fetch(base+route,{dispatcher,signal:header.signal});header.clear();scope.streaming();
    const reader=scope.reader(response);let body='';
    while(true){const {done,value}=await readWithIdle(reader,600000,scope.signal);if(done)break;body+=Buffer.from(value).toString();}
    assert.match(body,/data: done/);
   } finally {header.clear();scope.finish();}
  }));
 } finally {await dispatcher.destroy();await new Promise(r=>server.close(r));}
});

test('native fetch still aborts delayed headers and silent bodies on client cancellation',async()=>{
 const dispatcher=createDispatcher();let closed=0,arrived;
 const firstArrived=new Promise(r=>arrived=r);
 const closedSignals={};const bothClosed=Promise.all(['/headers','/body'].map(route=>new Promise(r=>closedSignals[route]=r))); 
 const server=http.createServer((req,res)=>{
  res.on('close',()=>{closed++;closedSignals[req.url]();});
  if(req.url==='/headers')arrived();
  if(req.url==='/body'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {
  const base='http://127.0.0.1:'+server.address().port;
  const headerCtl=new AbortController();
  const first=fetch(base+'/headers',{dispatcher,signal:headerCtl.signal});
  const rejected=assert.rejects(first,{name:'AbortError'});
  await firstArrived;headerCtl.abort();await rejected;
  const ctl=new AbortController();const response=await fetch(base+'/body',{dispatcher,signal:ctl.signal});
  const reader=response.body.getReader();const pending=readWithIdle(reader,600000,ctl.signal);
  ctl.abort(new Error('client disconnected'));await assert.rejects(pending,/client disconnected/);
 } finally {await dispatcher.destroy();await new Promise(r=>server.close(r));}
 await bothClosed;assert.equal(closed,2);
});
