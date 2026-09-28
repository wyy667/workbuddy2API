'use strict';

function cancelled(message = 'client disconnected') {
  const e = new Error(message); e.name = 'AbortError'; e.clientCancelled = true; return e;
}
function timeout(message, field) {
  const e = new Error(message); e.name = 'TimeoutError'; e[field] = true; return e;
}
function stopReader(reader, reason) { try { Promise.resolve(reader.cancel(reason)).catch(() => {}); } catch {} }
function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason || cancelled());
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    if (signal.aborted) aborted();
  });
}

function readWithIdle(reader, ms, signal) {
  if (signal?.aborted) { stopReader(reader, signal.reason); return Promise.reject(signal.reason); }
  let timer, onAbort;
  const failure = new Promise((_, reject) => {
    const fail = reason => { reject(reason); stopReader(reader, reason); };
    timer = setTimeout(() => fail(timeout(`upstream idle timeout (${ms}ms)`, 'idleTimeout')), ms);
    onAbort = () => fail(signal.reason || cancelled());
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([reader.read(), failure]).finally(() => {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
  });
}

function withHeadersTimeout(signal, ms) {
  const ctl = new AbortController();
  // Clearing the header timer must not break parent cancellation during the body.
  const merged = signal ? AbortSignal.any([signal, ctl.signal]) : ctl.signal;
  const timer = setTimeout(() => ctl.abort(timeout('upstream headers timeout', 'headersTimeout')), ms);
  return { signal: merged, clear: () => clearTimeout(timer) };
}

// budgetMs covers admission → upstream response headers (account selection, token
// refresh, retries). Once an upstream response is accepted, streaming() swaps it for
// streamMaxMs so long generations are bounded by idle timeout + a generous hard cap
// instead of being cut at the pre-response budget.
function createRequestScope(req, res, budgetMs, streamMaxMs = 0) {
  const controller = new AbortController(), readers = new Set();
  let timer = setTimeout(() => controller.abort(timeout('request budget exceeded', 'requestTimeout')), budgetMs);
  let streamingStarted = false;
  // readWithIdle rejects before cancellation; cancelling here would race read()
  // and turn an aborted stream into a successful EOF.
  const onAbort = () => {};
  const onRequestAborted = () => controller.abort(cancelled());
  const onClose = () => { if (!res.writableEnded) onRequestAborted(); };
  controller.signal.addEventListener('abort', onAbort);
  req.once('aborted', onRequestAborted); res.once('close', onClose);
  if (req.aborted || res.destroyed) onRequestAborted();
  return {
    signal: controller.signal,
    streaming() {
      if (streamingStarted || controller.signal.aborted) return;
      streamingStarted = true;
      clearTimeout(timer); timer = null;
      if (streamMaxMs > 0) timer = setTimeout(() => controller.abort(timeout('stream duration exceeded', 'requestTimeout')), streamMaxMs);
    },
    reader(response) {
      const reader = response.body.getReader(); readers.add(reader);
      if (controller.signal.aborted) stopReader(reader, controller.signal.reason);
      return reader;
    },
    release(reader) { stopReader(reader); readers.delete(reader); try { reader.releaseLock(); } catch {} },
    finish() {
      clearTimeout(timer); req.off('aborted', onRequestAborted); res.off('close', onClose);
      controller.signal.removeEventListener('abort', onAbort);
      for (const reader of readers) stopReader(reader);
      readers.clear();
    },
  };
}

async function writeChunk(res, chunk, signal) {
  if (signal?.aborted) throw signal.reason;
  if (res.destroyed || res.writableEnded) throw cancelled();
  if (res.write(chunk)) return;
  await new Promise((resolve, reject) => {
    const clean = () => { res.off('drain', drained); res.off('close', closed); res.off('error', failed); signal?.removeEventListener('abort', aborted); };
    const drained = () => { clean(); resolve(); };
    const closed = () => { clean(); reject(cancelled()); };
    const failed = e => { clean(); reject(e); };
    const aborted = () => { clean(); reject(signal.reason); };
    res.once('drain', drained); res.once('close', closed); res.once('error', failed);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

function outcomeOf(error, signal) {
  const e = signal?.aborted ? signal.reason : error;
  return e?.clientCancelled ? 'client_cancelled' : e?.idleTimeout || e?.requestTimeout || e?.headersTimeout || e?.name === 'TimeoutError' ? 'timeout' : 'upstream_error';
}

function createAdmission(max) {
  let active = 0;
  return { get active() { return active; }, acquire() {
    if (active >= max) return null;
    active++; let released = false;
    return () => { if (!released) { released = true; active--; } };
  } };
}
// Splits decoded SSE text into complete lines without re-copying the unread tail
// for every line. Returns the unconsumed remainder.
function splitLines(buf, onLine) {
  let start = 0, idx;
  while ((idx = buf.indexOf('\n', start)) >= 0) { onLine(buf.slice(start, idx)); start = idx + 1; }
  return start ? buf.slice(start) : buf;
}
module.exports = { splitLines, readWithIdle, withHeadersTimeout, createRequestScope, writeChunk, outcomeOf, createAdmission, stopReader, abortable };
