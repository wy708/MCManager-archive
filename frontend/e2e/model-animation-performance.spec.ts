import {test,expect} from '@playwright/test'
import {deflateSync} from 'node:zlib'

function pngChunk(type:string,data:Buffer){
  const content=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff
  for(const byte of content){crc^=byte;for(let n=0;n<8;n++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}
  const size=Buffer.alloc(4),checksum=Buffer.alloc(4);size.writeUInt32BE(data.length);checksum.writeUInt32BE((crc^0xffffffff)>>>0)
  return Buffer.concat([size,content,checksum])
}
const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(2,4);header[8]=8;header[9]=6
const sprite=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',header),pngChunk('IDAT',deflateSync(Buffer.from([0,255,0,0,255,0,0,0,255,255]))),pngChunk('IEND',Buffer.alloc(0))])

test('animated models skip held frames and stop rendering outside the viewport',async({page})=>{
  const id='00000000-0000-4000-8000-000000000001',build='00000000-0000-4000-8000-000000000002',texture='a'.repeat(64)+'.png',at='2026-01-01T00:00:00Z'
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
  await page.setViewportSize({width:1200,height:900})
  await page.addInitScript(()=>{
    const w=window as any;w.modelDraws=0;w.modelUploads=0
    for(const method of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced']){
      const original=(WebGL2RenderingContext.prototype as any)[method]
      ;(WebGL2RenderingContext.prototype as any)[method]=function(...args:any[]){w.modelDraws++;return original.apply(this,args)}
    }
    for(const method of ['texImage2D','texSubImage2D']){
      const original=(WebGL2RenderingContext.prototype as any)[method]
      ;(WebGL2RenderingContext.prototype as any)[method]=function(...args:any[]){w.modelUploads++;return original.apply(this,args)}
    }
  })
  await page.route('**/api/public/projects/**',async route=>{
    const path=new URL(route.request().url()).pathname
    if(path.endsWith('.png'))return route.fulfill({contentType:'image/png',body:sprite})
    if(path.endsWith('/status'))return route.fulfill({json:{state:'READY',message:'',build,version:1,latestVersion:1,observedAt:at,issues:[]}})
    if(path.endsWith('/height-range'))return route.fulfill({json:{minY:64,maxY:64,suggestedMinY:64,basis:'PLAYER_PLACEMENT'}})
    if(path.endsWith('/history'))return route.fulfill({json:{frames:[],more:false}})
    if(path.endsWith('/scene.json'))return route.fulfill({json:{format:1,renderer:'test sprite',issues:[],animations:{[texture]:{height:1,interpolate:false,frames:[0,4,1,4]}},models:[{x:0,y:64,z:0,entity:false,faces:[{points:[0,0,0,16,0,0,16,16,0,0,16,0],uvs:[0,0,16,0,16,16,0,16],texture,doubleSided:true}]}]}})
    return route.fulfill({json:{project:{id,serverId:id,serverName:'Isolated rendering fixture',name:'Animated model',creator:'QA',dimension:'minecraft:overworld',minX:0,maxX:1,minZ:0,maxZ:1,revision:1,status:'COMPLETE',publicUrl:'/projects/'+id},revision:1,startedAt:at,endedAt:at,statistics:{materials:[],contributors:[]},mapAt:null,mapMetadata:null,mapAvailable:false,revisions:[1],notice:''}})
  })
  await page.goto(`/projects/${id}?lang=zh-CN#model`)
  const canvas=page.locator('.model-canvas canvas')
  await expect(page.locator('.project-model')).toContainText('已显示 2 个模型面片')
  await canvas.evaluate(el=>el.scrollIntoView({block:'center'}))
  await page.waitForTimeout(250)
  await page.evaluate(()=>{(window as any).modelDraws=0;(window as any).modelUploads=0})
  await page.waitForTimeout(1000)
  const active=await page.evaluate(()=>({draws:(window as any).modelDraws,uploads:(window as any).modelUploads}))
  expect(active.draws).toBeGreaterThanOrEqual(2)
  expect(active.draws).toBeLessThanOrEqual(8)
  expect(active.uploads).toBeLessThanOrEqual(8)
  await page.evaluate(()=>{const spacer=document.createElement('div');spacer.style.height='3000px';document.body.append(spacer);scrollTo(0,document.body.scrollHeight)})
  await page.waitForTimeout(250)
  const offscreen=await page.evaluate(()=>({draws:(window as any).modelDraws,uploads:(window as any).modelUploads}))
  await page.waitForTimeout(500)
  expect(await page.evaluate(()=>({draws:(window as any).modelDraws,uploads:(window as any).modelUploads}))).toEqual(offscreen)
  await canvas.evaluate(el=>el.scrollIntoView({block:'center'}))
  await expect.poll(()=>page.evaluate(()=>(window as any).modelDraws)).toBeGreaterThan(offscreen.draws)
  await page.getByRole('button',{name:'二维地图',exact:true}).click()
  await expect(canvas).toHaveCount(0)
  await page.waitForTimeout(150)
  const disposed=await page.evaluate(()=>(window as any).modelDraws)
  await page.waitForTimeout(300)
  expect(await page.evaluate(()=>(window as any).modelDraws)).toBe(disposed)
  expect(errors).toEqual([])
})
