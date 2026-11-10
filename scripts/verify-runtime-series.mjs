import assert from 'node:assert/strict';
import {runtimeSeries} from '../frontend/src/runtimeSeries.ts';
const stamp=s=>new Date(Date.UTC(2026,10,7)+s*1000).toISOString();
const point=(s,value=20)=>({at:stamp(s),tps:value,cpuPercent:0,memoryMiB:600,players:1,maxTickIntervalMillis:55});
const report=(points,extra={})=>({from:stamp(0),to:stamp(180),bucketSeconds:10,points,events:[],...extra});
const interior=values=>values.slice(1,-1);
// These rounded buckets come from normal roughly 11-second sampling.
const jitter=report([point(10),point(20),point(30),point(50),point(60)]);
assert.deepEqual(interior(runtimeSeries(jitter,'tps')).map(p=>p[1]),[20,20,20,20,20]);
assert.equal(interior(runtimeSeries(jitter,'cpuPercent')).every(p=>p[1]===0),true);
assert.deepEqual(interior(runtimeSeries(report([point(10),point(70)]),'tps')).map(p=>p[1]),[20,null,20]);
assert.deepEqual(interior(runtimeSeries(report([point(10),point(20,null),point(30)]),'tps')).map(p=>p[1]),[20,null,20]);
for(const type of ['STOPPED','RESTART'])assert.deepEqual(interior(runtimeSeries(report([point(10),point(30)],{events:[{at:stamp(20),type}]}),'tps')).map(p=>p[1]),[20,null,20]);
assert.deepEqual(interior(runtimeSeries(report([point(0),point(60),point(180)],{bucketSeconds:60,to:stamp(240)}),'tps')).map(p=>p[1]),[20,20,null,20]);
assert.deepEqual(runtimeSeries(report([]),'tps'),[]);
console.log('Runtime series: sampling drift, real gaps, lifecycle boundaries, zero and unknown values verified');
