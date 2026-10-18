import { Readable } from 'node:stream';
import { Response, Headers } from 'node-fetch';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { fetchSafe } = vi.hoisted(() => ({ fetchSafe: vi.fn() }));
vi.mock('../../src/utils/network.js', async original => ({ ...await original(), fetchSafe }));
import { prepareClientMediaResponse } from '../../src/services/clientMediaRelayService.js';
import { rewriteMp4Metadata } from '../../src/utils/clientMp4.js';

const url = 'https://provider.example/video.mp4';
const target = 'https://manager.test/r/1234567890123456789012';
function box(type, payload) {
  const b = Buffer.alloc(8 + payload.length); b.writeUInt32BE(b.length); b.write(type, 4); payload.copy(b, 8); return b;
}
function fixture() {
  const xml = Buffer.from('<WRMHEADER><DATA><LA_URL>https://provider.example/license/very-long-private-provider-token-secret</LA_URL></DATA></WRMHEADER>', 'utf16le');
  const pro = Buffer.alloc(10 + xml.length); pro.writeUInt32LE(pro.length); pro.writeUInt16LE(1, 4); pro.writeUInt16LE(1, 6); pro.writeUInt16LE(xml.length, 8); xml.copy(pro, 10);
  const p = Buffer.alloc(24); Buffer.from('9a04f07998404286ab92e65be0885f95','hex').copy(p, 4); p.writeUInt32BE(pro.length, 20);
  return Buffer.concat([box('ftyp', Buffer.from('isom0000')), box('moov', box('pssh', Buffer.concat([p,pro]))), box('mdat', Buffer.alloc(200, 3))]);
}
const collect = async body => { const chunks = []; for await (const chunk of body) chunks.push(chunk); return Buffer.concat(chunks); };
function upstream(data, start = 0, end = data.length - 1, etag = '"v1"', status = 206) {
  const headers = { 'content-type': 'video/mp4', 'content-length': String(status === 206 ? end-start+1 : data.length) };
  if (etag) headers.etag = etag;
  if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${data.length}`;
  return new Response(Readable.from([status === 206 ? data.subarray(start, end+1) : data]), { status, headers });
}
function provider(data, etag = '"v1"') {
  fetchSafe.mockImplementation(async (_url, options) => {
    const h = new Headers(options.headers); const range = h.get('range');
    if (!range) return upstream(data, 0, data.length-1, etag, 200);
    const [,s,e] = /^bytes=(\d+)-(\d+)$/.exec(range);
    expect(h.get('if-match')).toBe(etag);
    return upstream(data, Number(s), Number(e), etag);
  });
}
beforeEach(() => { fetchSafe.mockReset(); });
describe('client media relay', () => {
  it.each(['video/x-matroska', 'application/octet-stream', null])('streams a late MKV range without rereading the whole movie (%s)', async type => {
    const total = 1693044896, length = 29174, start = total-length;
    const bytes = Buffer.alloc(length, 7);
    const response = new Response(Readable.from([bytes]), { status: 206, headers: {
      'content-length': String(length), 'content-range': `bytes ${start}-${total-1}/${total}`,
      ...(type ? { 'content-type': type } : {}),
    } });
    fetchSafe.mockRejectedValue(new Error('Unexpected whole-movie download'));
    const result = await prepareClientMediaResponse(response, { url: 'https://provider.example/movie.mkv', mapUrl: () => target });
    expect(result.status).toBe(206);
    expect(result.headers.get('content-range')).toBe(`bytes ${start}-${total-1}/${total}`);
    expect(await collect(result.body)).toEqual(bytes);
    expect(fetchSafe).not.toHaveBeenCalled();
  });
  it('still inspects explicit MP4 content served under a MKV filename', async () => {
    const data = fixture(); provider(data, null);
    const result = await prepareClientMediaResponse(upstream(data,80,230,null), { url: 'https://provider.example/movie.mkv', mapUrl: () => target });
    expect(await collect(result.body)).toEqual(rewriteMp4Metadata(data, () => target).subarray(80,231));
  });
  it('starts metadata parsing only after the caller can attach an error handler', async () => {
    const invalid=Buffer.alloc(8); invalid.writeUInt32BE(7); invalid.write('moov',4);
    let read=false;
    const source=Readable.from((async function*(){read=true;yield invalid;})());
    const r=await prepareClientMediaResponse(new Response(source),{url,mapUrl:()=>target});
    await new Promise(resolve=>setImmediate(resolve));
    expect(read).toBe(false);
    const failed=new Promise(resolve=>r.body.once('error',resolve));
    r.body.resume();
    expect(await failed).toBeInstanceOf(Error);
    expect(source.destroyed).toBe(true);
  });
  it('rewrites a full streaming MP4 without changing media bytes', async () => {
    const data = fixture(); const r = await prepareClientMediaResponse(upstream(data,0,data.length-1,'"v1"',200), { url, mapUrl: () => target });
    expect(await collect(r.body)).toEqual(rewriteMp4Metadata(data, () => target));
  });
  it.each([200, 206])('inspects metadata after a leading event box for status %s', async status => {
    const data=Buffer.concat([box('emsg', Buffer.alloc(4)), fixture()]);
    provider(data);
    const r=await prepareClientMediaResponse(upstream(data,0,data.length-1,'"v1"',status),{url,mapUrl:()=>target});
    expect(await collect(r.body)).toEqual(rewriteMp4Metadata(data,()=>target));
  });
  it.each([200, 206])('rejects malformed known MP4 instead of bypassing inspection for status %s', async status => {
    const data=Buffer.from('not a valid MP4 header containing private provider metadata');
    provider(data);
    const r=await prepareClientMediaResponse(upstream(data,0,data.length-1,'"v1"',status),{url,mapUrl:()=>target});
    await expect(collect(r.body)).rejects.toThrow();
  });
  it.each([[200,false],[206,false],[206,true]])('rejects external item data references through a top-level meta box for status %s (media only: %s)',async (status,mediaOnly)=>{
    const location=Buffer.from('https://provider.example/private-sample?token=secret\0');
    const entry=box('url ',Buffer.concat([Buffer.alloc(4),location]));
    const dref=box('dref',Buffer.concat([Buffer.from([0,0,0,0,0,0,0,1]),entry]));
    const data=Buffer.concat([box('meta',Buffer.concat([Buffer.alloc(4),box('dinf',dref)])),box('mdat',Buffer.alloc(16))]);
    provider(data);
    const start=mediaOnly?data.length-8:status===206?data.indexOf(location):0;
    const operation=async()=>{
      const r=await prepareClientMediaResponse(upstream(data,start,data.length-1,'"v1"',status),{url,mapUrl:()=>target});
      return collect(r.body);
    };
    await expect(operation()).rejects.toThrow(/reference/i);
  });
  it('drops compressed wire headers for the decoded full response body', async () => {
    const data=fixture(); const original=upstream(data,0,data.length-1,'"v1"',200);
    original.headers.set('content-encoding','gzip'); original.headers.set('content-length','99');
    const r=await prepareClientMediaResponse(original,{url,mapUrl:()=>target});
    expect(r.headers.get('content-encoding')).toBeNull(); expect(r.headers.get('content-length')).toBeNull();
    expect(await collect(r.body)).toEqual(rewriteMp4Metadata(data,()=>target));
  });
  it('rewrites an arbitrary range inside a private LA_URL using pinned complete metadata', async () => {
    const data = fixture(); const start = data.indexOf(Buffer.from('provider.example','utf16le')); const end = start + 39;
    provider(data);
    const r = await prepareClientMediaResponse(upstream(data,start,end), { url, mapUrl: () => target, fetchOptions: { headers: { Authorization: 'upstream-only', Range: `bytes=${start}-${end}` } } });
    expect(r.status).toBe(206); expect(r.headers.get('content-range')).toBe(`bytes ${start}-${end}/${data.length}`);
    expect(await collect(r.body)).toEqual(rewriteMp4Metadata(data, () => target).subarray(start,end+1));
    expect(fetchSafe.mock.calls.every(([,o]) => new Headers(o.headers).get('authorization') === 'upstream-only')).toBe(true);
  });
  it('falls back to a streaming full fetch for a missing validator', async () => {
    const data = fixture(); provider(data, null); const start = 80, end = 230;
    const r = await prepareClientMediaResponse(upstream(data,start,end,null), { url, mapUrl: () => target, fetchOptions: { headers: { Range: `bytes=${start}-${end}`, 'If-Range': 'old' } } });
    expect(await collect(r.body)).toEqual(rewriteMp4Metadata(data, () => target).subarray(start,end+1));
    expect(new Headers(fetchSafe.mock.calls[0][1].headers).get('range')).toBeNull();
    expect(new Headers(fetchSafe.mock.calls[0][1].headers).get('if-range')).toBeNull();
  });
  it('seeks past a gigabyte mdat using only headers and bounded metadata', async () => {
    const original = fixture(); const moovSize = original.readUInt32BE(16); const moov = original.subarray(16,16+moovSize);
    const ftyp = original.subarray(0,16); const media = Buffer.alloc(8); const mediaSize = 1_000_000_008;
    media.writeUInt32BE(mediaSize); media.write('mdat',4);
    const movieStart = 16+mediaSize; const total = movieStart+moov.length; const start = movieStart+100,end=start+59;
    const parts = [{start:0,bytes:ftyp},{start:16,bytes:media},{start:movieStart,bytes:moov}];
    const read = (s,e) => {
      const out = Buffer.alloc(e-s+1);
      for (const p of parts) { const a=Math.max(s,p.start),b=Math.min(e+1,p.start+p.bytes.length); if(a<b) p.bytes.copy(out,a-s,a-p.start,b-p.start); }
      return out;
    };
    const response = (s,e) => new Response(Readable.from([read(s,e)]), {status:206, headers:{etag:'"v1"','content-range':`bytes ${s}-${e}/${total}`,'content-length':String(e-s+1)}});
    let received = 0;
    fetchSafe.mockImplementation(async (_url,options) => { const [,s,e]=/^bytes=(\d+)-(\d+)$/.exec(new Headers(options.headers).get('range')); received += Number(e)-Number(s)+1; return response(Number(s),Number(e)); });
    const r = await prepareClientMediaResponse(response(start,end), {url,mapUrl:()=>target});
    expect(await collect(r.body)).toEqual(rewriteMp4Metadata(moov,()=>target).subarray(start-movieStart,end-movieStart+1));
    expect(received).toBeLessThan(2048);
  });
  it.each(['ignored range','changed validator'])('uses a fresh full representation after %s', async failure => {
    const data=fixture(); let calls=0;
    fetchSafe.mockImplementation(async (_url,options) => {
      calls++; const range=new Headers(options.headers).get('range');
      if (!range || failure==='ignored range') return upstream(data,0,data.length-1,'"v2"',200);
      const [,s,e]=/^bytes=(\d+)-(\d+)$/.exec(range); return upstream(data,Number(s),Number(e),'"v2"');
    });
    const r=await prepareClientMediaResponse(upstream(data,80,180),{url,mapUrl:()=>target});
    expect(r.headers.get('etag')).toBe('"v2"'); expect(await collect(r.body)).toEqual(rewriteMp4Metadata(data,()=>target).subarray(80,181)); expect(calls).toBe(2);
  });
  it('rejects a fallback with a different representation length', async () => {
    const data=fixture(); fetchSafe.mockResolvedValue(upstream(Buffer.concat([data,Buffer.alloc(8)]),0,0,null,200));
    await expect(prepareClientMediaResponse(upstream(data,80,180,null),{url,mapUrl:()=>target})).rejects.toThrow(/safely/);
  });
  it('preserves a non-MP4 range after inspecting the pinned prefix', async () => {
    const data=Buffer.from('this is an ordinary MPEG transport stream or image'); provider(data);
    const response=upstream(data,10,30); response.headers.set('content-type','video/mp2t');
    const r=await prepareClientMediaResponse(response,{url:'https://provider.example/video.ts',mapUrl:()=>{throw new Error('unexpected DRM');}});
    expect(await collect(r.body)).toEqual(data.subarray(10,31)); expect(fetchSafe).toHaveBeenCalledTimes(2);
  });
  it('passes cookie rotations to later probes and the final mapper response', async () => {
    const data=fixture(); const cookieJar={cookies:[]}; let count=0;
    provider(data); const original=fetchSafe.getMockImplementation();
    fetchSafe.mockImplementation(async (...args)=>{ if(count++) expect(args[1].cookieJar).toBe(cookieJar); const response=await original(...args); response.upstreamCookieJar=cookieJar; return response; });
    const mapper=vi.fn(()=>target); const r=await prepareClientMediaResponse(upstream(data,80,180),{url,mapUrl:mapper}); await collect(r.body);
    expect(mapper.mock.calls[0][2].upstreamCookieJar).toBe(cookieJar);
  });
  it('stops the full fallback at the requested end instead of downloading media', async () => {
    const data=fixture(); const source=Readable.from((async function*(){ yield data.subarray(0,data.length-208); for(let n=0;n<1_000_000;n++) yield Buffer.alloc(1024); })());
    fetchSafe.mockResolvedValue(new Response(source,{status:200,headers:{'content-length':String(data.length)}}));
    const r=await prepareClientMediaResponse(upstream(data,80,180,null),{url,mapUrl:()=>target}); await collect(r.body);
    expect(source.destroyed).toBe(true);
  });
  it('propagates consumer cancellation and keeps normal media backpressure bounded', async () => {
    let read=0; const header=Buffer.alloc(8); header.writeUInt32BE(100_000_008); header.write('mdat',4);
    const source=Readable.from((async function*(){yield header; for(let n=0;n<100_000;n++){read++;yield Buffer.alloc(1024);} })(),{objectMode:false,highWaterMark:16384});
    const r=await prepareClientMediaResponse(new Response(source),{url,mapUrl:()=>target});
    await new Promise(resolve=>setTimeout(resolve,10)); expect(read).toBeLessThan(256); r.body.destroy();
    await new Promise(resolve=>setTimeout(resolve,10)); expect(source.destroyed).toBe(true);
  });
  it('aborts a pending range probe with the caller signal', async () => {
    const data=fixture(); const controller=new AbortController();
    fetchSafe.mockImplementation((_url,options)=>new Promise((resolve,reject)=>{ options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}); }));
    const result=prepareClientMediaResponse(upstream(data,80,180),{url,mapUrl:()=>target,fetchOptions:{signal:controller.signal}});
    controller.abort(); await expect(result).rejects.toThrow(/aborted/);
  });
  it('bounds fallback inspection time before the requested bytes become available', async () => {
    vi.useFakeTimers();
    try {
      const data=fixture(); const source=new Readable({read(){}});
      fetchSafe.mockResolvedValue(new Response(source,{status:200,headers:{'content-length':String(data.length)}}));
      const r=await prepareClientMediaResponse(upstream(data,80,180,null),{url,mapUrl:()=>target});
      const reading=collect(r.body); const check=expect(reading).rejects.toThrow(/safely/);
      await vi.advanceTimersByTimeAsync(30_001); await check; expect(source.destroyed).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});
