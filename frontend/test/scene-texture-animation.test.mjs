import {test} from 'node:test'
import assert from 'node:assert/strict'
import {textureAnimation} from '../src/sceneTextureAnimation.ts'

test('held frames update only when pixels change, preserving timing and loop wrap',()=>{
  const sample=textureAnimation([0,4,1,4],false),changes=[]
  for(let time=0;time<1000;time+=50){const frame=sample(time);if(frame)changes.push([time,frame.frame])}
  assert.deepEqual(changes,[[0,0],[200,1],[400,0],[600,1],[800,0]])
})
test('interpolation retains every original 50ms blend',()=>{
  const sample=textureAnimation([0,2,1,2],true)
  assert.deepEqual([0,50,100,150,200].map(sample),[
    {frame:0,next:0,mix:0},{frame:0,next:1,mix:.5},
    {frame:1,next:1,mix:0},{frame:1,next:0,mix:.5},{frame:0,next:0,mix:0},
  ])
})
test('returning after a pause samples current time without replaying missed frames',()=>{
  const sample=textureAnimation([2,4,5,4],false)
  assert.equal(sample(0).frame,2)
  assert.equal(sample(10200).frame,5)
  assert.equal(sample(10250),undefined)
})
test('repeated identical sprite frames do not redraw even when interpolation is enabled',()=>{
  const sample=textureAnimation([3,2,3,2],true)
  assert.deepEqual(sample(0),{frame:3,next:3,mix:0})
  for(let time=50;time<1000;time+=50)assert.equal(sample(time),undefined)
})
