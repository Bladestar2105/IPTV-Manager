
import fs from 'fs';
import path from 'path';
import os from 'os';
import { performance } from 'perf_hooks';

const BENCH_DIR = path.join(os.tmpdir(), `proxy_bench_${Date.now()}`);
const FILE_COUNT = 1000;
const FILE_SIZE = 50 * 1024; // 50KB

const buffer = Buffer.alloc(FILE_SIZE, 'a');

function setup() {
  if (!fs.existsSync(BENCH_DIR)) {
    fs.mkdirSync(BENCH_DIR);
  }
}

function teardown() {
  try {
    fs.rmSync(BENCH_DIR, { recursive: true, force: true });
  } catch(e) {}
}

async function measureLoopDelay(fn) {
  let ticks = 0;
  const start = performance.now();

  // Ticker to measure event loop responsiveness
  const interval = setInterval(() => {
    ticks++;
  }, 1);

  await fn();

  clearInterval(interval);
  const end = performance.now();
  const duration = end - start;

  // Expected ticks is duration (ms).
  // If ticks is much lower, event loop was blocked.
  // Blocking Ratio: (duration - ticks) / duration
  // 0 = no blocking, 1 = full blocking

  return {
    duration,
    ticks,
    blockingRatio: Math.max(0, (duration - ticks) / duration)
  };
}

async function runSync() {
  // Simulate concurrent requests reaching the point of writing
  // In a real server, requests come in async, but the write blocks everything.
  // So we just iterate and write.
  for (let i = 0; i < FILE_COUNT; i++) {
    const filePath = path.join(BENCH_DIR, `sync_${i}.png`);
    try {
        fs.writeFileSync(filePath, buffer);
    } catch (e) {}
  }
}

async function runAsync() {
  // Simulate concurrent requests
  // In async mode, we can fire off many writes and await them.
  // We use the "safe" approach: write to temp, then rename.
  const promises = [];
  for (let i = 0; i < FILE_COUNT; i++) {
    const filePath = path.join(BENCH_DIR, `async_${i}.png`);
    const tempPath = `${filePath}.tmp`;
    promises.push((async () => {
        await fs.promises.writeFile(tempPath, buffer);
        await fs.promises.rename(tempPath, filePath);
    })());
  }
  await Promise.all(promises);
}

async function main() {
  try {
    setup();

    console.log(`Benchmarking ${FILE_COUNT} writes of ${FILE_SIZE/1024}KB each.`);

    console.log('\n--- Sync Benchmark (fs.writeFileSync) ---');
    const syncResult = await measureLoopDelay(async () => {
        await runSync();
    });
    console.log(`Duration: ${syncResult.duration.toFixed(2)}ms`);
    console.log(`Ticks (Event Loop Cycles): ${syncResult.ticks}`);
    console.log(`Blocking Ratio: ${(syncResult.blockingRatio * 100).toFixed(2)}% (Higher is worse)`);


    console.log('\n--- Async Benchmark (fs.promises.writeFile + rename) ---');
    const asyncResult = await measureLoopDelay(async () => {
        await runAsync();
    });
    console.log(`Duration: ${asyncResult.duration.toFixed(2)}ms`);
    console.log(`Ticks (Event Loop Cycles): ${asyncResult.ticks}`);
    console.log(`Blocking Ratio: ${(asyncResult.blockingRatio * 100).toFixed(2)}% (Lower is better)`);

    console.log('\n--- Summary ---');
    if (syncResult.blockingRatio > asyncResult.blockingRatio) {
        console.log(`Async is ${(syncResult.blockingRatio / asyncResult.blockingRatio).toFixed(1)}x less blocking than Sync.`);
    } else {
        console.log('Async is not significantly better.');
    }

    if (asyncResult.duration < syncResult.duration) {
         console.log(`Async finished ${(syncResult.duration / asyncResult.duration).toFixed(1)}x faster.`);
    }

  } catch (error) {
    console.error('Benchmark failed:', error);
  } finally {
    teardown();
  }
}

main();
