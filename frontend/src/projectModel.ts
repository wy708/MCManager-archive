export interface ModelBlock { name: string; states: string }
export interface ModelSection { x:number; y:number; z:number; palette:ModelBlock[]; runs:number[] }
export interface ModelStatus { version:number; sections:number; blocks:number; lastObservedAt:string|null; status:string; notice:string }
export interface ModelPage { sections:{x:number;y:number;z:number;observedAt:string;data:ModelSection}[]; next:string|null; model:ModelStatus }
export interface ModelGeometry { positions:Float32Array; normals:Float32Array; uvs:Float32Array; blocks:string[]; count:number; truncated:boolean; bounds:number[] }
const faces=[
  {d:[-1,0,0],v:[[0,0,1],[0,1,1],[0,0,0],[0,1,0]]},
  {d:[1,0,0],v:[[1,0,0],[1,1,0],[1,0,1],[1,1,1]]},
  {d:[0,-1,0],v:[[1,0,1],[0,0,1],[1,0,0],[0,0,0]]},
  {d:[0,1,0],v:[[0,1,1],[1,1,1],[0,1,0],[1,1,0]]},
  {d:[0,0,-1],v:[[0,0,0],[0,1,0],[1,0,0],[1,1,0]]},
  {d:[0,0,1],v:[[1,0,1],[1,1,1],[0,0,1],[0,1,1]]},
]
const transparent=(name:string)=>/glass|leaves|water|ice|fence|pane|door|trapdoor|stairs|slab|torch|rail|grass|flower|sapling/.test(name)
// Face culling and meshing run in a worker, so orbiting the previous model stays responsive.
export function modelGeometry(sections:ModelSection[],minY:number,maxY:number,limit=250000):ModelGeometry {
  const voxels=new Map<string,{x:number;y:number;z:number;block:ModelBlock;tile:number}>(),types=new Map<string,number>()
  let truncated=false
  outer:for(const section of sections){let cursor=0
    for(let r=0;r<section.runs.length;r+=2){const index=section.runs[r]!,length=section.runs[r+1]!,block=section.palette[index]!
      for(let j=0;j<length;j++,cursor++){const x=section.x+cursor%8,y=section.y+Math.floor(cursor/64),z=section.z+Math.floor(cursor/8)%8
        if(!index||y<minY||y>maxY)continue
        if(voxels.size>=limit){truncated=true;break outer}
        if(!types.has(block.name))types.set(block.name,types.size<1023?types.size:1023)
        voxels.set(`${x},${y},${z}`,{x,y,z,block,tile:types.get(block.name)!})
      }
    }
  }
  const bounds=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity]
  for(const v of voxels.values()){bounds[0]=Math.min(bounds[0]!,v.x);bounds[1]=Math.min(bounds[1]!,v.y);bounds[2]=Math.min(bounds[2]!,v.z);bounds[3]=Math.max(bounds[3]!,v.x+1);bounds[4]=Math.max(bounds[4]!,v.y+1);bounds[5]=Math.max(bounds[5]!,v.z+1)}
  if(!voxels.size)bounds.fill(0)
  const center=[(bounds[0]!+bounds[3]!)/2,(bounds[1]!+bounds[4]!)/2,(bounds[2]!+bounds[5]!)/2]
  const positions:number[]=[],normals:number[]=[],uvs:number[]=[]
  // Limit surface complexity as well as voxel count (e.g. a checkerboard has no hidden faces).
  let triangles=0
  outer:for(const v of voxels.values()) {
    const slab=v.block.name.includes('slab')&&!v.block.name.includes('double'),top=/top_slot_bit["']?\s*:\s*(1|true)|vertical_half["']?\s*:\s*["']?top/.test(v.block.states)
    const thin=/rail|carpet|pressure_plate/.test(v.block.name),low=slab&&top?0.5:0,high=slab?(top?1:0.5):thin?0.08:1
    for(const face of faces){const [dx,dy,dz]=face.d,neighbor=voxels.get(`${v.x+dx!},${v.y+dy!},${v.z+dz!}`)
      if(!slab&&!thin&&neighbor&&(!transparent(neighbor.block.name)||neighbor.block.name===v.block.name))continue
      if(triangles>=Math.min(500000,limit*2)){truncated=true;break outer}triangles+=2
      const tx=v.tile%32,ty=Math.floor(v.tile/32)
      for(const index of [0,1,2,2,1,3]){const p=face.v[index]!,u=index<2?0:1,w=index%2===0?1:0
        positions.push(v.x+p[0]!-center[0]!,v.y+low+p[1]!*(high-low)-center[1]!,v.z+p[2]!-center[2]!)
        normals.push(dx!,dy!,dz!);uvs.push((tx+0.02+u*0.96)/32,1-(ty+0.02+w*0.96)/32)
      }
    }
  }
  return {positions:new Float32Array(positions),normals:new Float32Array(normals),uvs:new Float32Array(uvs),blocks:[...types.keys()].slice(0,1024),count:voxels.size,truncated,bounds}
}
