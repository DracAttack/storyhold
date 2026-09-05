import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve('.storyhold-data/recovery-current-20260905');
const table = Array.from({length:256}, (_, n) => {
  for(let k=0;k<8;k++) n = (n & 1) ? (n >>> 1) ^ 0x82f63b78 : n >>> 1;
  return n >>> 0;
});
function crc32c(parts) {
  let crc=0xffffffff;
  for(const part of parts) for(const b of part) crc=table[(crc^b)&255]^(crc>>>8);
  return (crc^0xffffffff)>>>0;
}
function lsn(n) {return `${(n>>32n).toString(16).toUpperCase()}/${(n&0xffffffffn).toString(16).toUpperCase()}`;}
const control=await readFile(path.join(root,'global/pg_control'));
const crcOffsets=[];
for(let p=32;p<512;p+=4) if(crc32c([control.subarray(0,p)])===control.readUInt32LE(p)) crcOffsets.push(p);
console.log(JSON.stringify({control:{systemIdentifier:control.readBigUInt64LE(0).toString(),version:control.readUInt32LE(8),catalog:control.readUInt32LE(12),state:control.readUInt32LE(16),time:control.readBigInt64LE(24).toString(),checkpoint:lsn(control.readBigUInt64LE(32)),crcOffsets,hex:control.subarray(0,crcOffsets[0]+4).toString('hex')}}));
for(const name of (await readdir(path.join(root,'pg_wal'))).filter(n=>/^[0-9A-F]{24}$/.test(n)).sort()) {
  const wal=await readFile(path.join(root,'pg_wal',name));
  const system=wal.readBigUInt64LE(24);
  const pageAddress=wal.readBigUInt64LE(8);
  const found=[];
  for(let off=40;off<wal.length-24;off+=8) {
    const len=wal.readUInt32LE(off);
    if(len<80||len>160||off+len>wal.length||Math.floor(off/8192)!==Math.floor((off+len-1)/8192))continue;
    if(wal[off+17]!==0||![0,16].includes(wal[off+16])||wal[off+24]!==255||wal.readUInt32LE(off+4)!==0)continue;
    if(wal[off+25]!==len-26)continue;
    if(crc32c([wal.subarray(off+24,off+len),wal.subarray(off,off+20)])!==wal.readUInt32LE(off+20))continue;
    const pageOff=Math.floor(off/8192)*8192;
    const address=wal.readBigUInt64LE(pageOff+8)+BigInt(off-pageOff);
    found.push({offset:off,len,info:wal[off+16],lsn:lsn(address),previous:lsn(wal.readBigUInt64LE(off+8)),payload:wal.subarray(off+26,off+len).toString('hex')});
  }
  if(found.length||name.endsWith('86'))console.log(JSON.stringify({name,pageAddress:lsn(pageAddress),systemIdentifier:system.toString(),magic:wal.readUInt16LE(0),records:found}));
}
