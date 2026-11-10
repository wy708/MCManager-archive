import { test, expect } from '@playwright/test'

test('scene loader retains geometry and shares textures with bounded parallel requests',async({page})=>{
  let active=0,peak=0
  const requests:string[]=[]
  await page.route('**/texture-qa/*.png',async route=>{
    requests.push(route.request().url());peak=Math.max(peak,++active)
    await new Promise(resolve=>setTimeout(resolve,80))
    active--
    await route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGPU6An4z8DAwMAEIkAYAB5AAgfNdB03AAAAAElFTkSuQmCC','base64')})
  })
  await page.goto('/')
  const result=await page.evaluate(async()=>{
    const source='/src/projectScene.ts'
    const {createProjectScene}=await import(source)
    const files=Array.from({length:12},(_,i)=>i.toString(16).padStart(64,'0')+'.png')
    const models=[...files,files[0]].map((texture,i)=>({x:i,y:64,z:0,entity:false,faces:[{points:[0,0,0,16,0,0,16,16,0,0,16,0],uvs:[0,0,16,0,16,16,0,16],texture,doubleSided:i%2===0}]}))
    const progress:number[]=[]
    const scene=await createProjectScene({format:1,models,issues:[],renderer:'test'},(file:string)=>'/texture-qa/'+file,undefined,{minY:64,maxY:65},(done:number)=>progress.push(done))
    const result={triangles:scene.triangles,progress,missing:scene.issues}
    scene.dispose();return result
  })
  expect(requests).toHaveLength(12)
  expect(new Set(requests).size).toBe(12)
  expect(peak).toBeGreaterThan(1)
  expect(peak).toBeLessThanOrEqual(4)
  expect(result.triangles).toBe(26)
  expect(result.progress).toEqual(Array.from({length:13},(_,i)=>i))
  expect(result.missing).toEqual([])
})

test('height boundary removes the lower layer surface but retains selected bottoms and crossing models',async({page})=>{
  await page.route('**/texture-qa/*.png',route=>route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGPU6An4z8DAwMAEIkAYAB5AAgfNdB03AAAAAElFTkSuQmCC','base64')}))
  await page.goto('/')
  const result=await page.evaluate(async()=>{
    const source='/src/projectScene.ts'
    const {createProjectScene}=await import(source)
    const texture='0'.repeat(64)+'.png'
    const face=(points:number[])=>({points,uvs:[0,0,16,0,16,16,0,16],texture,doubleSided:true})
    const horizontal=(y:number)=>face([0,y,0,16,y,0,16,y,16,0,y,16])
    const model=(x:number,y:number,faces:unknown[])=>({x,y,z:0,entity:false,faces})
    const models=[
      model(0,66,[horizontal(16)]), // exposed grass top at 67
      model(1,67,[horizontal(0)]), // selected block bottom at 67
      model(2,66,[face([0,0,0,16,0,0,16,32,0,0,32,0])]), // spans 66..68
      model(3,93,[horizontal(0)]), // next layer bottom at upper boundary
    ]
    const scene=await createProjectScene({format:1,models,issues:[],renderer:'test'},(file:string)=>'/texture-qa/'+file,undefined,{minY:67,maxY:92})
    const result={triangles:scene.triangles,minX:scene.bounds.min.x,maxX:scene.bounds.max.x}
    scene.dispose();return result
  })
  expect(result).toEqual({triangles:4,minX:1,maxX:3})
})
