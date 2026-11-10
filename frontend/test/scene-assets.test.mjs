import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { loadSceneAssets } from '../src/sceneAssetPool.ts'

test('loads every asset with at most four active transfers', async () => {
  const pending=[],seen=[]
  let active=0,peak=0
  const result=loadSceneAssets(Array.from({length:13},(_,i)=>i),async item=>{
    seen.push(item);peak=Math.max(peak,++active)
    await new Promise(resolve=>pending.push(resolve));active--
  })
  assert.equal(active,4)
  while(seen.length<13||active){pending.splice(0).forEach(resolve=>resolve());await setImmediate()}
  await result
  assert.equal(peak,4)
  assert.deepEqual([...seen].sort((a,b)=>a-b),Array.from({length:13},(_,i)=>i))
})

test('a failed transfer cancels siblings and waits for their cleanup', async () => {
  const failure=new Error('broken texture'),seen=[]
  let cleaned=0
  await assert.rejects(loadSceneAssets([0,1,2,3,4,5],async (item,signal)=>{
    seen.push(item)
    if(item===0){await setImmediate();throw failure}
    await new Promise(resolve=>signal.addEventListener('abort',()=>{setImmediate().then(()=>{cleaned++;resolve()})},{once:true}))
  }),error=>error===failure)
  assert.deepEqual(seen,[0,1,2,3]);assert.equal(cleaned,3)
})

test('caller cancellation stops queued transfers; pre-aborted loads never start', async () => {
  const controller=new AbortController(),seen=[]
  const result=loadSceneAssets([0,1,2,3,4],async(item,signal)=>{
    seen.push(item)
    await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))
  },controller.signal)
  controller.abort()
  await assert.rejects(result,{name:'AbortError'})
  assert.equal(seen.length,4)
  await assert.rejects(loadSceneAssets([5],async()=>{throw Error('must not run')},controller.signal),{name:'AbortError'})
})
