import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeVoiceUpload} from './voice-upload-codec.mjs';
function fixture(){
 const b=Buffer.alloc(62);b.write('RIFF');b.writeUInt32LE(54,4);b.write('WAVEfmt ',8);
 b.writeUInt32LE(18,16);b.writeUInt16LE(7,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);
 b.writeUInt32LE(16000,28);b.writeUInt16LE(1,32);b.writeUInt16LE(8,34);
 b.write('fact',38);b.writeUInt32LE(4,42);b.writeUInt32LE(4,46);b.write('data',50);b.writeUInt32LE(4,54);
 b.set([255,127,0,128],58);return b;
}
test('mu-law WAV becomes provider-compatible PCM with signed endpoint and silence values',()=>{
 const b=decodeVoiceUpload(fixture(),8);
 assert.equal(b.length,52);assert.equal(b.readUInt16LE(20),1);assert.equal(b.readUInt32LE(24),16000);
 assert.deepEqual([0,1,2,3].map(i=>b.readInt16LE(44+i*2)),[0,0,-32124,32124]);
});
test('decoded size and WAV chunk boundaries are bounded before allocation',()=>{
 assert.throws(()=>decodeVoiceUpload(fixture(),7),/too_large/);
 const b=fixture();b.writeUInt32LE(0x7fffffff,54);assert.throws(()=>decodeVoiceUpload(b,8000),/chunk/);
 const stereo=fixture();stereo.writeUInt16LE(2,22);assert.throws(()=>decodeVoiceUpload(stereo,8000),/format/);
 const raw=Buffer.from([1,2,3]);assert.equal(decodeVoiceUpload(raw,3),raw);
});
