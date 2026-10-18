import { describe, expect, it } from 'vitest';
import { validateClientTtml } from '../src/utils/clientTtml.js';

const document = inner => `<?xml version="1.0" encoding="UTF-8"?><tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" xml:lang="en">${inner}</tt>`;
describe('static TTML captions', () => {
  it('preserves timed captions, entities, layout and styling', () => {
    const xml = document('<head><styling><style xml:id="s1" tts:color="white" tts:fontSize="20px"/></styling><layout><region xml:id="r1" tts:origin="10% 80%" tts:extent="80% 20%"/></layout></head><body region="r1"><div><p begin="00:00:01.000" end="00:00:03.000" style="s1">Hello &amp; welcome<br/><span tts:fontWeight="bold">world &#33;</span></p></div></body>');
    expect(validateClientTtml(xml)).toBe(xml);
  });
  it('accepts prefixed TTML elements and a standard text profile', () => {
    const xml = '<tt:tt xmlns:tt="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:profile="http://www.w3.org/ns/ttml/profile/imsc1/text"><tt:body><tt:div><tt:p begin="1s" dur="2s">Caption</tt:p></tt:div></tt:body></tt:tt>';
    expect(validateClientTtml(xml)).toBe(xml);
  });
  it('preserves inert comments, CDATA caption text and title metadata', () => {
    const xml = '<tt xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><head><metadata><ttm:title>Captions</ttm:title></metadata></head><body><!-- generated --><div><p><![CDATA[<Caption & text>]]></p></div></body></tt>';
    expect(validateClientTtml(xml)).toBe(xml);
  });
  it.each([
    '<!DOCTYPE tt [<!ENTITY source SYSTEM "https://upstream/secret">]><tt>&source;</tt>',
    '<?xml-stylesheet href="https://upstream/style.css"?><tt/>',
    document('<body><image src="https://upstream/image.png"/></body>'),
    document('<body xml:base="https://upstream/"><div><p>caption</p></div></body>'),
    document('<body><div><p tts:backgroundImage="https://upstream/image.png">caption</p></div></body>'),
    document('<body><div><p tts:fontFamily="url(https://upstream/font)">caption</p></div></body>'),
    document('<body><div><p tts:fontFamily="u&#114;l(https://upstream/font)">caption</p></div></body>'),
    document('<body><div><p href="https://upstream/">caption</p></div></body>'),
    document('<body><div><p src="data:image/png;base64,AA==">caption</p></div></body>'),
    document('<body><div><p>caption</div></p></body>'),
    '<html><body>caption</body></html>',
    '<tt xmlns="https://untrusted.example/custom"><body/></tt>',
    '<tt xmlns:tts="https://untrusted.example/custom"><body tts:color="white"/></tt>',
    '<tt/><tt/>',
    '<tt><body>&unknown;</body></tt>',
    '<tt xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:profile="https://upstream/profile"><body/></tt>',
  ])('rejects unsupported or externally active documents (%s)', xml => {
    expect(() => validateClientTtml(xml)).toThrow();
  });
});
