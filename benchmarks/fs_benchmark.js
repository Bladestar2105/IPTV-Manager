
import fs from 'fs';
import path from 'path';
import os from 'os';
import { performance } from 'perf_hooks';

const BENCH_DIR = path.join(os.tmpdir(), `epg_bench_${Date.now()}`);
const FILE_COUNT = 5000;
const MISSING_PERCENTAGE = 0.2;

function setup() {
  console.log(`Setting up benchmark in ${BENCH_DIR}...`);
  if (!fs.existsSync(BENCH_DIR)) {
    fs.mkdirSync(BENCH_DIR);
  }

  // Create dummy files
  for (let i = 0; i < FILE_COUNT; i++) {
    if (Math.random() > MISSING_PERCENTAGE) {
      fs.writeFileSync(path.join(BENCH_DIR, `epg_provider_${i}.xml`), '<tv></tv>');
    }
  }
}

function teardown() {
  console.log('Cleaning up...');
  try {
    fs.rmSync(BENCH_DIR, { recursive: true, force: true });
  } catch(e) {}
}

function runSync() {
  const start = performance.now();
  const providers = Array.from({ length: FILE_COUNT }, (_, i) => ({ id: i }));
  const epgFiles = [];
  for (const provider of providers) {
    const cacheFile = path.join(BENCH_DIR, `epg_provider_${provider.id}.xml`);
    if (fs.existsSync(cacheFile)) {
      epgFiles.push({ file: cacheFile, source: `Provider ${provider.id}` });
    }
  }
  return performance.now() - start;
}

async function runAsync() {
  const start = performance.now();
  const providers = Array.from({ length: FILE_COUNT }, (_, i) => ({ id: i }));

  const results = await Promise.all(providers.map(async (provider) => {
    const cacheFile = path.join(BENCH_DIR, `epg_provider_${provider.id}.xml`);
    try {
      await fs.promises.stat(cacheFile);
      return { file: cacheFile, source: `Provider ${provider.id}` };
    } catch {
      return null;
    }
  }));

  const epgFiles = results.filter(Boolean);
  return performance.now() - start;
}

async function runReaddir() {
  const start = performance.now();
  const providers = Array.from({ length: FILE_COUNT }, (_, i) => ({ id: i }));

  const files = new Set(await fs.promises.readdir(BENCH_DIR));
  const epgFiles = [];

  for (const provider of providers) {
    const filename = `epg_provider_${provider.id}.xml`;
    if (files.has(filename)) {
        epgFiles.push({ file: path.join(BENCH_DIR, filename), source: `Provider ${provider.id}` });
    }
  }

  return performance.now() - start;
}

async function main() {
  try {
    setup();

    console.log('Warming up...');
    runSync();
    await runAsync();
    await runReaddir();

    console.log('Running Sync Benchmark (existsSync)...');
    const syncTime = runSync();
    console.log(`Sync Time: ${syncTime.toFixed(2)}ms`);

    console.log('Running Async Benchmark (Promise.all + stat)...');
    const asyncTime = await runAsync();
    console.log(`Async Time: ${asyncTime.toFixed(2)}ms`);

    console.log('Running Readdir Benchmark (readdir + Set)...');
    const readdirTime = await runReaddir();
    console.log(`Readdir Time: ${readdirTime.toFixed(2)}ms`);

    if (syncTime > 0) {
        const improvement = ((syncTime - readdirTime) / syncTime) * 100;
        console.log(`Readdir Improvement vs Sync: ${improvement.toFixed(2)}%`);
    }

  } catch (error) {
    console.error('Benchmark failed:', error);
  } finally {
    teardown();
  }
}

main();
