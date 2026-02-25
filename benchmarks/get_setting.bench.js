import { performance } from 'perf_hooks';
import { getSetting } from '../src/utils/helpers.js';

// Mock db
const db = {
  prepare: () => ({
    get: () => ({ value: 'test-value' })
  })
};

const iterations = 1000000;
console.log(`Benchmarking getSetting with ${iterations} iterations (mocked DB)...`);

const start = performance.now();
for (let i = 0; i < iterations; i++) {
  getSetting(db, 'test-key', 'default');
}
const end = performance.now();
const time = end - start;
console.log(`Time: ${time.toFixed(4)}ms`);
console.log(`Average: ${(time / iterations * 1000000).toFixed(4)}ns per call`);
