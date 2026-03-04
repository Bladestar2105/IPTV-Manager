const fs = require('fs');
const XmlStream = require('node-xml-stream');

function generateLargeXml(channelCount, programsPerChannel) {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="Benchmark">\n';

    // Generate channels
    for (let i = 0; i < channelCount; i++) {
        xml += `  <channel id="ch.${i}">
    <display-name>Channel ${i}</display-name>
    <icon src="http://example.com/logo${i}.png" />
  </channel>\n`;
    }

    // Generate programs
    const now = Date.now();
    for (let i = 0; i < channelCount; i++) {
        for (let j = 0; j < programsPerChannel; j++) {
            const start = new Date(now + j * 3600000).toISOString().replace(/[-:T.]/g, '').slice(0, 14) + " +0000";
            const stop = new Date(now + (j + 1) * 3600000).toISOString().replace(/[-:T.]/g, '').slice(0, 14) + " +0000";
            xml += `  <programme start="${start}" stop="${stop}" channel="ch.${i}">
    <title>Program ${j} on Channel ${i}</title>
    <desc>Description for program ${j}...</desc>
  </programme>\n`;
        }
    }

    xml += '</tv>';
    return xml;
}

const { Readable } = require('stream');

const xml = generateLargeXml(5000, 5);
const buf = Buffer.from(xml);
const readable = new Readable();
readable.push(buf);
readable.push(null);

console.time("node-xml-stream");
const parser = new XmlStream();

parser.on('opentag', (name, attrs) => {
    // console.log(name);
});
parser.on('text', text => {
    // console.log(text);
});
parser.on('closetag', name => {
    // console.log(name);
});
parser.on('finish', () => {
    console.timeEnd("node-xml-stream");
});

readable.pipe(parser);
