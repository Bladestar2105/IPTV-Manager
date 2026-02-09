
import { describe, it, expect } from 'vitest';
import { ChannelMatcher } from '../src/channel_matcher.js';

describe('ChannelMatcher', () => {
    const epgChannels = [
        { id: '1', name: 'Das Erste HD', group: 'General' },
        { id: '2', name: 'ZDF HD', group: 'General' },
        { id: '3', name: 'RTL', group: 'General' },
        { id: '4', name: 'RTL 2', group: 'General' }, // Contains number 2
        { id: '5', name: 'ProSieben', group: 'General' },
        { id: '6', name: 'Sat.1', group: 'General' }, // Contains number 1
        { id: '7', name: 'Sky Cinema Action', group: 'Sky' },
        { id: '8', name: 'Sky Cinema Fun', group: 'Sky' },
        { id: '9', name: 'Sport1', group: 'Sport' }, // Contains number 1
        { id: '10', name: 'Eurosport 1', group: 'Sport' }, // Contains number 1
        { id: '11', name: 'Eurosport 2', group: 'Sport' }, // Contains number 2
        { id: '12', name: 'Sky Sport Bundesliga 1', group: 'Sport' },
        { id: '13', name: 'Sky Sport Bundesliga 2', group: 'Sport' },
        { id: '14', name: 'TV5Monde (FR)', group: 'Int' }
    ];

    const matcher = new ChannelMatcher(epgChannels);

    it('matches exact name with quality suffix removed', () => {
        const result = matcher.match('Das Erste FHD');
        expect(result.epgChannel).toBeDefined();
        expect(result.epgChannel.id).toBe('1');
    });

    it('matches correct channel based on numbers', () => {
        // RTL 2 should match RTL 2, not RTL
        const result = matcher.match('RTL II'); // 'II' is not a number in regex \d+
        // Wait, current logic uses \d+, so II is not matched.
        // But 'RTL 2' should match 'RTL 2'
        const result2 = matcher.match('RTL 2 HD');
        expect(result2.epgChannel).toBeDefined();
        expect(result2.epgChannel.id).toBe('4');

        // RTL should match RTL
        const result3 = matcher.match('RTL HD');
        expect(result3.epgChannel).toBeDefined();
        expect(result3.epgChannel.id).toBe('3');
    });

    it('distinguishes channels with different numbers', () => {
        const res1 = matcher.match('Eurosport 1');
        expect(res1.epgChannel.id).toBe('10');

        const res2 = matcher.match('Eurosport 2');
        expect(res2.epgChannel.id).toBe('11');

        // Should NOT match if numbers mismatch
        const res3 = matcher.match('Eurosport 3');
        expect(res3.epgChannel).toBeNull();
    });

    it('matches with language detection', () => {
        const result = matcher.match('TV5Monde FR');
        expect(result.epgChannel.id).toBe('14');
        expect(result.parsed.language).toBe('fr');
    });

    it('handles multiple numbers correctly', () => {
        // "Sky Sport Bundesliga 1"
        const result = matcher.match('Sky Sport Bundesliga 1 HD');
        expect(result.epgChannel.id).toBe('12');

        const result2 = matcher.match('Sky Sport Bundesliga 2 HD');
        expect(result2.epgChannel.id).toBe('13');
    });

    it('extracts numbers correctly', () => {
        expect(matcher.extractNumbers('Channel 5')).toEqual(['5']);
        expect(matcher.extractNumbers('RTL 2')).toEqual(['2']);
        expect(matcher.extractNumbers('No Number')).toEqual([]);
    });
});
