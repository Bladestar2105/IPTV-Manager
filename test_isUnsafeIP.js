import { isUnsafeIP, cleanIp } from './src/utils/helpers.js';
console.log('127.0.0.1:', isUnsafeIP('127.0.0.1'));
console.log('192.168.1.1:', isUnsafeIP('192.168.1.1'));
console.log('10.0.0.1:', isUnsafeIP('10.0.0.1'));
console.log('172.16.0.1:', isUnsafeIP('172.16.0.1'));
console.log('8.8.8.8:', isUnsafeIP('8.8.8.8'));
