
import { ChannelMatcher } from '../src/services/channelMatcher.js';
import { bench, describe } from 'vitest';

describe('ChannelMatcher', () => {
  const epgChannels = [];
  for (let i = 0; i < 5000; i++) {
    epgChannels.push({ id: `${i}`, name: `Channel ${i} HD DE` });
    epgChannels.push({ id: `sports_${i}`, name: `Sports Channel ${i} [UK]` });
    epgChannels.push({ id: `movie_${i}`, name: `Movie Network ${i} (US)` });
  }

  const matcher = new ChannelMatcher(epgChannels);

  // Pre-warm
  matcher.match('Channel 100 DE');

  bench('match exact', () => {
    matcher.match('Channel 2500 HD DE');
  });

  bench('match fuzzy', () => {
    matcher.match('Sprts Chnl 2500 UK');
  });

  bench('match no match', () => {
    matcher.match('Non Existent Channel 99999');
  });

  bench('parseChannelName', () => {
      matcher.parseChannelName('Super Cool Channel 123 (DE)');
  });
});
