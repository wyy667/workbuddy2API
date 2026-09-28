const Agent = require('undici/lib/dispatcher/agent.js');
module.exports = function createChatDispatcher() {
  const agent = new Agent({ headersTimeout: 0, bodyTimeout: 0, connections: 32, pipelining: 1 });
  return {
    // Native fetch can supply its own 300s parser defaults. Override per dispatch;
    // the application AbortSignal and readWithIdle own the deadlines instead.
    dispatch(options, handler) {
      return agent.dispatch({ ...options, headersTimeout: 0, bodyTimeout: 0 }, handler);
    },
    close: () => agent.close(),
    destroy: () => agent.destroy(),
  };
};
