import fs from 'fs';
import { performance } from 'perf_hooks';

const FILE_SIZE = 50 * 1024 * 1024; // 50MB to ensure it takes some time
const TEMP_FILE = 'temp_bench_file.bin';

function createLargeFile() {
    const buffer = Buffer.alloc(FILE_SIZE, 'a');
    fs.writeFileSync(TEMP_FILE, buffer);
}

function cleanup() {
    if (fs.existsSync(TEMP_FILE)) fs.unlinkSync(TEMP_FILE);
}

async function run() {
    createLargeFile();

    console.log(`File size: ${FILE_SIZE / 1024 / 1024} MB`);

    // --- Sync Benchmark ---
    console.log('\n--- Sync Read ---');
    let start = performance.now();

    // Schedule a timer. If code blocks, this won't run until after.
    let timerRunSync = false;
    const tSync = setTimeout(() => {
        timerRunSync = true;
        console.log('  [Timer] Timer fired during Sync operation (Unexpected!)');
    }, 1);

    const dataSync = fs.readFileSync(TEMP_FILE);

    // Clear timer if it hasn't run
    clearTimeout(tSync);

    let end = performance.now();
    console.log(`Sync Read Time: ${(end - start).toFixed(2)}ms`);
    console.log(`Did timer fire during operation? ${timerRunSync ? 'YES' : 'NO (BLOCKED)'}`);


    // --- Async Benchmark ---
    // Wait a bit
    await new Promise(r => setTimeout(r, 100));

    console.log('\n--- Async Read ---');
    start = performance.now();

    let timerRunAsync = false;
    // We expect this timer to fire WHILE the file is being read
    const tAsync = setTimeout(() => {
        timerRunAsync = true;
        console.log('  [Timer] Timer fired during Async operation');
    }, 1);

    const dataAsync = await fs.promises.readFile(TEMP_FILE);

    end = performance.now();
    console.log(`Async Read Time: ${(end - start).toFixed(2)}ms`);
    console.log(`Did timer fire during operation? ${timerRunAsync ? 'YES (NON-BLOCKING)' : 'NO'}`);

    cleanup();
}

run().catch(console.error);
