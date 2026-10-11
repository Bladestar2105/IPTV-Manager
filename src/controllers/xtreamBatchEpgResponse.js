import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setImmediate } from 'node:timers/promises';
import { getEpgProgramsPage } from '../services/epgService.js';
import { formatXtreamEpgListing } from './xtreamControllerUtils.js';

export const streamBatchEpgResponse = async (res, channelsByStreamId, start, end, limit) => {
  async function* body() {
    yield '{';
    let firstChannel = true;
    for (const [streamId, epgId] of channelsByStreamId) {
      yield `${firstChannel ? '' : ','}${JSON.stringify(String(streamId))}:{"epg_listings":[`;
      firstChannel = false;
      let count = 0;
      while (count < limit) {
        const pageSize = Math.min(128, limit - count);
        const programs = getEpgProgramsPage(epgId, start, end, pageSize, count);
        for (const program of programs) {
          yield `${count > 0 ? ',' : ''}${JSON.stringify(formatXtreamEpgListing(program, epgId))}`;
          count++;
        }
        // Release each SQLite read before yielding to other requests or slow clients.
        await setImmediate();
        if (programs.length < pageSize) break;
      }
      yield ']}';
    }
    yield '}';
  }
  res.setHeader('Content-Type', 'application/json');
  await pipeline(Readable.from(body(), { objectMode: false, highWaterMark: 1024 }), res);
};
