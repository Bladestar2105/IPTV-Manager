import { describe, it, expect } from 'vitest';
import { ChannelMatcher } from '../src/services/channelMatcher.js';

describe('ChannelMatcher', () => {
    const epgChannels = [
        { id: '1', name: 'ARD Das Erste' },
        { id: '2', name: 'ZDF HD' },
        { id: '3', name: 'RTL Television' },
        { id: '4', name: 'SAT.1' },
        { id: '5', name: 'ProSieben' },
        { id: '6', name: 'VOX' },
        { id: '7', name: 'Kabel Eins' },
        { id: '8', name: 'RTL II' },
        { id: '9', name: 'Super RTL' },
        { id: '10', name: 'Sky Cinema Action HD' },
        { id: '11', name: 'Sky Sport Bundesliga 1 HD' },
        { id: '12', name: 'DAZN 1' },
        { id: '13', name: 'US: CNN International' },
        { id: '14', name: 'UK: BBC One' },
        { id: '15', name: 'DE: Sky Cinema Fun' } // German
    ];

    const matcher = new ChannelMatcher(epgChannels);

    it('matches exact names ignoring case and suffix', () => {
        const result = matcher.match('ARD Das Erste HD');
        expect(result.epgChannel.id).toBe('1');
        // Confidence might vary but should be high
        expect(result.confidence).toBeGreaterThan(0.8);
    });

    it('matches with language prefix', () => {
        const result = matcher.match('DE: ZDF');
        expect(result.epgChannel.id).toBe('2');
    });

    it('matches with different formatting', () => {
        const result = matcher.match('RTL Tele-vision');
        expect(result.epgChannel.id).toBe('3');
    });

    it('matches numbers correctly', () => {
        const result = matcher.match('DAZN 1');
        expect(result.epgChannel.id).toBe('12');
    });

    it('matches fuzzy names', () => {
        const result = matcher.match('Sky Cin. Action');
        expect(result.epgChannel.id).toBe('10');
    });

    it('does not match completely different names', () => {
        const result = matcher.match('Cartoon Network');
        if (result.epgChannel) {
             expect(result.confidence).toBeLessThan(0.5);
        } else {
             expect(result.epgChannel).toBeNull();
        }
    });

    it('prioritizes language match', () => {
        const parsed = matcher.parseChannelName('US: CNN');
        expect(parsed.language).toBe('en');
    });

    it('verifies memory optimization changes do not break logic', () => {
        // Ensure parsed object structure is flattened and optimized
        const item = matcher.parsedEpgChannels[0];

        // Check flattened properties
        expect(item.channel).toBeDefined();
        expect(item.baseName).toBeDefined();
        expect(item.numbersString).toBeDefined();

        // Check removed properties
        expect(item.parsed).toBeUndefined(); // Flattened
        expect(item.bigramCount).toBeUndefined(); // Removed

        // Check new/renamed properties
        expect(item.signaturePopcount).toBeDefined();
        expect(item.signaturePopcount).toBeGreaterThan(0);
    });
});
