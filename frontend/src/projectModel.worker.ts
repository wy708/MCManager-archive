import { modelGeometry } from './projectModel'
const scope=self as unknown as {onmessage:((event:MessageEvent)=>void)|null;postMessage:(message:unknown,transfer?:Transferable[])=>void}
scope.onmessage=(event)=>{
  const {sections,minY,maxY,generation,limit}=event.data
  try { const result=modelGeometry(sections,minY,maxY,limit);scope.postMessage({generation,result},[result.positions.buffer,result.normals.buffer,result.uvs.buffer]) }
  catch {scope.postMessage({generation,error:'模型较大，生成失败，请缩小显示高度后重试。'})}
}
