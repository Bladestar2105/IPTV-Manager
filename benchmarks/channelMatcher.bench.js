
import { ChannelMatcher } from '../src/services/channelMatcher.js';
import { bench, describe } from 'vitest';

describe('ChannelMatcher', () => {
  const epgChannels = [];
  for (let i = 0; i < 5000; i++) {
    epgChannels.push({ id: `${i}`, name: `Channel ${i} HD DE` });
    epgChannels.push({ id: `sports_${i}`, name: `Sports Channel ${i} [UK]` });
    epgChannels.push({ id: `movie_${i}`, name: `Movie Network ${i} (US)` });
  }
  // Add many channels without numbers to stress test fallback
  for (let i = 0; i < 1000; i++) {
     epgChannels.push({ id: `news_${i}`, name: `Breaking News Network` }); // Duplicate names to fill bucket
     epgChannels.push({ id: `music_${i}`, name: `Music TV` });
     epgChannels.push({ id: `docu_${i}`, name: `Documentary Channel` });
  }


  const matcher = new ChannelMatcher(epgChannels);

  // Pre-warm
  matcher.match('Channel 100 DE');

  bench('match exact', () => {
    matcher.match('Channel 2500 HD DE');
  });

  bench('match fuzzy (numbers)', () => {
    matcher.match('Sprts Chnl 2500 UK');
  });

  bench('match fuzzy (no numbers)', () => {
    // This should hit the bucket of channels with no numbers
    matcher.match('Musik TeeVee');
  });

  bench('match no match', () => {
    matcher.match('Non Existent Channel 99999');
  });

  bench('parseChannelName', () => {
      matcher.parseChannelName('Super Cool Channel 123 (DE)');
  });
});
