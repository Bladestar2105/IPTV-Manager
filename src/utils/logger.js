import util from 'util';

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalInfo = console.info;
const originalDebug = console.debug;

function getTimestamp() {
  return new Date().toISOString();
}

// The cluster interleaves the output of a dozen workers in one stream. Without
// the pid it is impossible to tell afterwards whether two adjacent lines belong
// to the same run or to two workers competing for the same lock.
const WORKER_TAG = `w${process.pid}`;

console.log = function(...args) {
  const msg = util.format(...args);
  originalLog(`[${getTimestamp()}] [${WORKER_TAG}] ${msg}`);
};

console.error = function(...args) {
  const msg = util.format(...args);
  originalError(`[${getTimestamp()}] [${WORKER_TAG}] ${msg}`);
};

console.warn = function(...args) {
  const msg = util.format(...args);
  originalWarn(`[${getTimestamp()}] [${WORKER_TAG}] ${msg}`);
};

console.info = function(...args) {
  const msg = util.format(...args);
  originalInfo(`[${getTimestamp()}] [${WORKER_TAG}] ${msg}`);
};

console.debug = function(...args) {
  const msg = util.format(...args);
  originalDebug(`[${getTimestamp()}] [${WORKER_TAG}] ${msg}`);
};
