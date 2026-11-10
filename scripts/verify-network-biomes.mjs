// Independent wire-format cross-check for the real-game scene test.
// Numeric biome palettes and 0xff inheritance are documented in PrismarineJS/prismarine-chunk:
// src/bedrock/1.18/{ChunkColumn,BiomeSection,ProxyBiomeSection}.js.
import assert from 'node:assert/strict';
function sections(packet){
  assert.ok([0,4294967294,4294967295,-1,-2].includes(packet.sub_chunk_count),'Expected biome-only level chunk');
  const bytes=packet.payload;let offset=0;const result=[];
  function variable(){let value=0;for(let shift=0;shift<35;shift+=7){assert.ok(offset<bytes.length);const next=bytes[offset++];value+=(next&127)*2**shift;if(!(next&128))return value;}throw Error('Invalid palette integer');}
  for(let section=0;section<24;section++){
    const header=bytes[offset++];assert.notEqual(header,undefined);
    if(header===255){assert.ok(result.length);result.push(result.at(-1));continue;}
    assert.equal(header&1,1);const bits=header>>>1;assert.ok(bits<=16);
    if(!bits){result.push(Array(4096).fill(variable()/2));continue;}
    const perWord=Math.floor(32/bits),wordCount=Math.ceil(4096/perWord),words=[];
    for(let i=0;i<wordCount;i++){words.push(bytes.readUInt32LE(offset));offset+=4;}
    const count=variable()/2;assert.ok(Number.isInteger(count)&&count>0&&count<=65536);
    const palette=Array.from({length:count},()=>variable()/2),mask=2**bits-1;
    result.push(Array.from({length:4096},(_,i)=>{const id=(words[Math.floor(i/perWord)]>>>((i%perWord)*bits))&mask;assert.ok(id<palette.length);return palette[id];}));
  }
  return result;
}
export function verifyNetworkBiomes(parts,packets,definitions){
  const decoded=new Map();let compared=0;
  for(const part of parts){const key=`${Math.floor(part.x/16)},${Math.floor(part.z/16)}`,packet=packets.get(key);assert.ok(packet,'Missing real game biome packet '+key);if(!decoded.has(key))decoded.set(key,sections(packet));
    const cells=[];for(let n=0;n<part.scene.biomeRuns.length;n+=2)cells.push(...Array(part.scene.biomeRuns[n+1]).fill(part.scene.biomePalette[part.scene.biomeRuns[n]]));
    for(let i=0;i<512;i++){const x=part.x+i%8,y=part.y+Math.floor(i/64),z=part.z+Math.floor(i/8)%8,index=((x&15)<<8)|((z&15)<<4)|(y&15);const id=decoded.get(key)[Math.floor((y+64)/16)][index];assert.equal(cells[i],definitions.get(id),`Biome mismatch at ${x},${y},${z}`);compared++;}
  }
  return compared;
}
