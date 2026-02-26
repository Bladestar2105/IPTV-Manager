
import fs from 'fs';
import path from 'path';
import os from 'os';
import { performance } from 'perf_hooks';

const BENCH_DIR = path.join(os.tmpdir(), `picons_bench_${Date.now()}`);
const FILE_COUNT = 5000;

function setup() {
  if (fs.existsSync(BENCH_DIR)) {
      try {
        fs.rmSync(BENCH_DIR, { recursive: true, force: true });
      } catch (e) {}
  }
  fs.mkdirSync(BENCH_DIR, { recursive: true });

  for (let i = 0; i < FILE_COUNT; i++) {
    fs.writeFileSync(path.join(BENCH_DIR, `picon_${i}.png`), 'fake-image');
  }
}

function cleanup() {
  try {
    if (fs.existsSync(BENCH_DIR)) {
      fs.rmSync(BENCH_DIR, { recursive: true, force: true });
    }
  } catch (error) {
    console.error('Cleanup failed:', error);
  }
}

function measureLag() {
    return new Promise(resolve => {
        const start = performance.now();
        setTimeout(() => {
            const lag = performance.now() - start;
            resolve(lag);
        }, 0);
    });
}

function runSync() {
  const start = performance.now();
  if (fs.existsSync(BENCH_DIR)) {
    const files = fs.readdirSync(BENCH_DIR);
    for (const file of files) {
      fs.unlinkSync(path.join(BENCH_DIR, file));
    }
  }
  return performance.now() - start;
}

async function runAsync() {
  const start = performance.now();
  if (fs.existsSync(BENCH_DIR)) {
    const files = await fs.promises.readdir(BENCH_DIR);
    await Promise.all(files.map(file => fs.promises.unlink(path.join(BENCH_DIR, file))));
  }
  return performance.now() - start;
}

async function runAsyncChunked(concurrency = 100) {
    const start = performance.now();
    if (fs.existsSync(BENCH_DIR)) {
        const files = await fs.promises.readdir(BENCH_DIR);
        for (let i = 0; i < files.length; i += concurrency) {
            const chunk = files.slice(i, i + concurrency);
            await Promise.all(chunk.map(file => fs.promises.unlink(path.join(BENCH_DIR, file))));
        }
    }
    return performance.now() - start;
}


async function main() {
    console.log(`Comparing deletion performance for ${FILE_COUNT} files.`);

    // --- Sync Test ---
    setup();
    console.log('\nRunning Sync Deletion...');

    // Measure lag during sync operation?
    // Since it's sync, we can't really "measure" lag during it easily without external process,
    // but effectively lag is 100% of the execution time.
    const syncStart = performance.now();
    runSync();
    const syncTime = performance.now() - syncStart;
    console.log(`Sync Time (Blocked): ${syncTime.toFixed(2)}ms`);
    cleanup();


    // --- Async Test ---
    setup();
    console.log('\nRunning Async Deletion...');

    // Start a ticker to measure lag
    let maxLag = 0;
    let totalLag = 0;
    let ticks = 0;
    const interval = setInterval(() => {
        const start = performance.now();
        setImmediate(() => {
            const lag = performance.now() - start;
            if (lag > maxLag) maxLag = lag;
            totalLag += lag;
            ticks++;
        });
    }, 10); // Check every 10ms

    const asyncStart = performance.now();
    await runAsync();
    const asyncTime = performance.now() - asyncStart;

    clearInterval(interval);
    console.log(`Async Time: ${asyncTime.toFixed(2)}ms`);
    console.log(`Async Max Event Loop Lag: ${maxLag.toFixed(2)}ms`);
    cleanup();

    // --- Async Chunked Test ---
    setup();
    console.log('\nRunning Async Chunked Deletion (Concurrency 100)...');

    maxLag = 0;
    totalLag = 0;
    ticks = 0;
    const intervalChunked = setInterval(() => {
        const start = performance.now();
        setImmediate(() => {
            const lag = performance.now() - start;
            if (lag > maxLag) maxLag = lag;
            totalLag += lag;
            ticks++;
        });
    }, 10);

    const asyncChunkedStart = performance.now();
    await runAsyncChunked(100);
    const asyncChunkedTime = performance.now() - asyncChunkedStart;

    clearInterval(intervalChunked);
    console.log(`Async Chunked Time: ${asyncChunkedTime.toFixed(2)}ms`);
    console.log(`Async Chunked Max Event Loop Lag: ${maxLag.toFixed(2)}ms`);

    cleanup();
}

main();
