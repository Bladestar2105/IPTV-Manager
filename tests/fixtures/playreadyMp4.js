export const providerLicense = 'https://provider.example/license?token=' + 'private-provider-token-'.repeat(6);
export function playreadyMp4(container = 'moov') {
  const box = (type, data) => {
    const result = Buffer.alloc(data.length + 8);
    result.writeUInt32BE(result.length); result.write(type, 4); data.copy(result, 8);
    return result;
  };
  const xml = Buffer.from(`<WRMHEADER><DATA><KID VALUE="keep" CHECKSUM="same"/><LA_URL>${providerLicense}</LA_URL></DATA></WRMHEADER>`, 'utf16le');
  const pro = Buffer.alloc(xml.length + 10);
  pro.writeUInt32LE(pro.length); pro.writeUInt16LE(1, 4); pro.writeUInt16LE(1, 6); pro.writeUInt16LE(xml.length, 8); xml.copy(pro, 10);
  const prefix = Buffer.alloc(24);
  Buffer.from('9a04f07998404286ab92e65be0885f95', 'hex').copy(prefix, 4);
  prefix.writeUInt32BE(pro.length, 20);
  return Buffer.concat([box('ftyp', Buffer.from('isom0000')), box(container, box('pssh', Buffer.concat([prefix, pro]))), box('mdat', Buffer.from('sample-bytes'))]);
}
