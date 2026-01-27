/**
 * Author: Bladestar2105
 * License: MIT
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const publicDir = path.join(__dirname, 'public');
const vendorDir = path.join(publicDir, 'vendor');

// Vendor-Verzeichnis erstellen
if (!fs.existsSync(vendorDir)) {
  fs.mkdirSync(vendorDir, { recursive: true });
}

console.log('📦 Copying vendor assets...');

// Bootstrap CSS
const bootstrapCssSrc = path.join(__dirname, 'node_modules/bootstrap/dist/css/bootstrap.min.css');
const bootstrapCssDest = path.join(vendorDir, 'bootstrap.min.css');
if (fs.existsSync(bootstrapCssSrc)) {
  fs.copyFileSync(bootstrapCssSrc, bootstrapCssDest);
  console.log('✅ Bootstrap CSS copied');
} else {
  console.error('❌ Bootstrap CSS not found');
}

// Bootstrap JS
const bootstrapJsSrc = path.join(__dirname, 'node_modules/bootstrap/dist/js/bootstrap.bundle.min.js');
const bootstrapJsDest = path.join(vendorDir, 'bootstrap.bundle.min.js');
if (fs.existsSync(bootstrapJsSrc)) {
  fs.copyFileSync(bootstrapJsSrc, bootstrapJsDest);
  console.log('✅ Bootstrap JS copied');
} else {
  console.error('❌ Bootstrap JS not found');
}

// SortableJS
const sortableSrc = path.join(__dirname, 'node_modules/sortablejs/Sortable.min.js');
const sortableDest = path.join(vendorDir, 'sortable.min.js');
if (fs.existsSync(sortableSrc)) {
  fs.copyFileSync(sortableSrc, sortableDest);
  console.log('✅ SortableJS copied');
} else {
  console.error('❌ SortableJS not found');
}

console.log('✅ All vendor assets copied to public/vendor/');
