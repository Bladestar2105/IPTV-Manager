import http from 'http';
import https from 'https';
import dns from 'dns';
import { isSafeIP } from './helpers.js';

const lookup = (hostname, options, callback) => {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    if (!isSafeIP(address)) {
      return callback(new Error(`Unsafe IP Blocked: ${address}`));
    }
    callback(null, address, family);
  });
};

export const httpAgent = new http.Agent({ lookup });
export const httpsAgent = new https.Agent({ lookup });
