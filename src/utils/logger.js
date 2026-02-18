import util from 'util';

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalInfo = console.info;

function getTimestamp() {
  return new Date().toISOString();
}

console.log = function(...args) {
  const msg = util.format(...args);
  originalLog(`[${getTimestamp()}] ${msg}`);
};

console.error = function(...args) {
  const msg = util.format(...args);
  originalError(`[${getTimestamp()}] ${msg}`);
};

console.warn = function(...args) {
  const msg = util.format(...args);
  originalWarn(`[${getTimestamp()}] ${msg}`);
};

console.info = function(...args) {
  const msg = util.format(...args);
  originalInfo(`[${getTimestamp()}] ${msg}`);
};
