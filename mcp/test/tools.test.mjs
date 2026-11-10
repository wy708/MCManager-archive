import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/tools.mjs';
import { ApiError } from '../src/api.mjs';

const serverId = randomUUID();
async function fixture(request, action) {
  const server = createServer({ request, config: { origin: 'https://mc.example.test' } });
  const client = new Client({ name: 'regression-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    await action(client);
  } finally { await client.close(); await server.close(); }
}
const call = (client, name, args = {}) => client.callTool({ name, arguments: { serverId, ...args } });
test('runtime history is server scoped, bounded and preserves missing data',async()=>{
 let calls=0;await fixture(async(path,options)=>{calls++;assert.equal(path,`/api/agent/servers/${serverId}/runtime`);assert.equal(options.query.hours,24);return {state:'STALE',latest:{cpuPercent:null},points:[]}},async client=>{
  const result=await call(client,'get_server_runtime');assert.equal(result.structuredContent.data.state,'STALE');assert.equal(result.structuredContent.data.latest.cpuPercent,null);
  assert.equal((await call(client,'get_server_runtime',{hours:169})).isError,true);assert.equal(calls,1);
 });
});

test('project creation and name lookup return clickable map links without viewer identity',async()=>{
  const id=randomUUID();const publicPath='/projects/'+id;const requests=[];
  await fixture(async(path,options)=>{
    requests.push({path,options});
    if(options.body)return {projectId:id,publicUrl:publicPath,mapUrl:'https://public.example.test'+publicPath};
    if(path.endsWith('/'+id))return {project:{id,publicUrl:publicPath,mapUrl:'https://public.example.test'+publicPath}};
    return [{id,name:'林间小屋',creator:'建设者',publicUrl:publicPath}];
  },async client=>{
    const list=await call(client,'list_construction_projects',{name:'林间小屋'});
    assert.equal(list.structuredContent.data[0].mapUrl,'https://mc.example.test'+publicPath);
    assert.deepEqual(requests[0].options.query,{name:'林间小屋'});
    assert.equal(requests[0].options.body,undefined);
    const created=await call(client,'create_construction_project',{requestId:randomUUID(),qqId:'12345678',name:'林间小屋',dimension:'minecraft:overworld',x1:0,z1:0,x2:10,z2:10});
    assert.equal(created.structuredContent.data.mapUrl,'https://public.example.test'+publicPath);
    const detail=await call(client,'get_construction_project',{projectId:id});
    assert.equal(detail.structuredContent.data.project.publicUrl,'https://public.example.test'+publicPath);
  });
});

test('project range update preserves trusted identity and retry key without automatic replay', async()=>{
  let count=0;
  const args={qqId:'12345678',requestId:randomUUID(),name:'小屋',dimension:'minecraft:overworld',x1:-10,z1:20,x2:30,z2:40};
  await fixture(async(path,options)=>{
    count++;assert.equal(path,`/api/agent/servers/${serverId}/projects`);
    const {qqId,...operation}=args;
    assert.deepEqual(options.body,{qqId,operation:{...operation,action:'UPDATE'}});
    throw new ApiError('BACKEND_TIMEOUT');
  },async client=>{
    const result=await call(client,'update_construction_range',args);
    assert.equal(result.isError,true);assert.equal(count,1);
    assert.deepEqual(result.structuredContent.recovery.arguments,{serverId,...args});
    assert.equal((await call(client,'update_construction_range',{...args,playerKey:'xuid:1'})).isError,true);
    assert.equal(count,1);
  });
});

test('all tools have Chinese titles and accurate mutation annotations', async () => {
  await fixture(() => assert.fail('listing must not access backend'), async client => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 39);
    for (const tool of tools) assert.match(tool.title, /[\u4e00-\u9fff]/);
    const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
    assert.equal(byName.unbind_qq_account.annotations.destructiveHint, true);
    assert.equal(byName.get_world_state.annotations.readOnlyHint, false);
    assert.equal(byName.get_world_state.annotations.idempotentHint, false);
    assert.equal(byName.send_chat_reply.annotations.idempotentHint, true);
    assert.equal(byName.get_last_player_snapshot.annotations.readOnlyHint, true);
    assert.equal(byName.get_terrain_prediction.annotations.readOnlyHint, true);
    assert.equal(byName.get_terrain_prediction.annotations.idempotentHint, true);
    assert.equal(byName.get_location_context.annotations.readOnlyHint, true);
    assert.equal(byName.get_location_context.annotations.idempotentHint, true);
    assert.equal(byName.get_structure_predictions.annotations.readOnlyHint,true);
    assert.equal(byName.get_chunk_info.annotations.readOnlyHint,true);
    assert.equal(byName.get_statistics_breakdown.annotations.readOnlyHint,true);
    assert.equal(byName.get_statistics_ranking.annotations.readOnlyHint,true);
    assert.equal(byName.get_container_history.annotations.readOnlyHint,true);
  });
});

test('container history keeps coordinates, identity and cursor, and rejects unsafe ranges', async () => {
  const requests=[];
  await fixture(async(path,options)=>{ requests.push({path,options}); return {items:[{attribution:'UNATTRIBUTED',playerKey:null}],nextBefore:'9007199254740993'}; },async client=>{
    const args={dimension:'minecraft:overworld',x:-12,y:64,z:10,before:'9007199254740995'};
    const result=await call(client,'get_container_history',args);
    assert.equal(result.structuredContent.data.nextBefore,'9007199254740993');
    assert.equal(result.structuredContent.data.items[0].playerKey,null);
    assert.equal(requests[0].path,`/api/agent/servers/${serverId}/container-history`);
    assert.deepEqual(requests[0].options.query,{...args,radius:0,limit:50});
    for(const extra of [{radius:17},{limit:101},{before:'0'},{y:9999},{x:1.5},{from:'2026-01-01T00:00:00Z',to:'2026-02-10T00:00:00Z'}])
      assert.equal((await call(client,'get_container_history',{...args,...extra})).isError,true);
    assert.equal(requests.length,1);
  });
});

test('statistics detail tools preserve filters and precision and reject invalid ranges before requests', async () => {
  const requests=[];
  await fixture(async(path,options)=>{requests.push({path,options});return {items:[{subject:'minecraft:bow',value:'9007199254740993'}],total:1};},async client=>{
    for(const [name,view] of [['get_statistics_breakdown','breakdown'],['get_statistics_ranking','ranking']]) {
      const result=await call(client,name,{metric:'items.used',playerKey:'xuid:123456789',fromDate:'2026-11-01',toDate:'2026-11-07',dimension:'minecraft:nether',page:2,pageSize:10});
      assert.equal(result.structuredContent.data.items[0].value,'9007199254740993');
      assert.equal(requests.at(-1).path,`/api/agent/servers/${serverId}/statistics/${view}`);
      assert.deepEqual(requests.at(-1).options.query,{metric:'items.used',playerKey:'xuid:123456789',fromDate:'2026-11-01',toDate:'2026-11-07',dimension:'minecraft:nether',page:2,pageSize:10});
      assert.equal(requests.at(-1).options.body,undefined);
    }
    await call(client,'get_statistics_ranking',{metric:'blocks.mined',category:'ORE'});
    assert.equal(requests.at(-1).options.query.playerKey,undefined);
    const count=requests.length;
    for(const args of [{metric:'items.used',category:'ORE'},{metric:'items.used',pageSize:101},{metric:'items.used',fromDate:'2026-11-07',toDate:'2026-11-01'}])
      assert.equal((await call(client,'get_statistics_ranking',args)).isError,true);
    assert.equal(requests.length,count);
  });
});

test('offline terrain tools accept full-precision seeds through a read-only calculation and never schedule a game query', async()=>{
  const requests=[];
  await fixture(async(path,options)=>{requests.push({path,options});return {status:'PREDICTED',source:'SEED_PREDICTION'};},async client=>{
    const result=await call(client,'get_terrain_prediction',{dimension:'minecraft:overworld',x:-1,z:-17,worldType:'DEFAULT'});
    assert.equal(result.structuredContent.data.status,'PREDICTED');
    assert.match(requests[0].path,/\/terrain-prediction$/);
    assert.equal(requests[0].options.body.at.y,64);assert.equal(requests[0].options.body.at.step,16);assert.equal(requests[0].options.body.seed,undefined);
    await call(client,'get_recorded_environment',{dimension:'minecraft:nether',x:0,y:64,z:0});
    assert.match(requests[1].path,/\/recorded-environment$/);
    await call(client,'get_terrain_prediction',{dimension:'minecraft:overworld',x:0,z:0,worldType:'DEFAULT',seed:'-9007199254740993',generationVersion:'1.26.61.1'});
    assert.equal(requests[2].options.body.seed,'-9007199254740993');assert.equal(requests[2].options.query,undefined);
    const invalid=await call(client,'get_terrain_prediction',{dimension:'minecraft:overworld',x:0,z:0,worldType:'DEFAULT',seed:'1'});
    assert.equal(invalid.isError,true);assert.equal(requests.length,3);
  });
});

test('combined location tool preserves both sources, timestamps and shared coordinates without forwarding the seed to history', async()=>{
  const requests=[];
  const history={status:'HISTORY',records:[{observedAt:'2026-11-01T00:00:00Z',source:'OBSERVED_HISTORY',data:{block:'minecraft:furnace'}}],truncated:true,completeWorldCoverage:false};
  const prediction={status:'PREDICTED',source:'SEED_PREDICTION',worldIdentityVerified:false};
  await fixture(async(path,options)=>{requests.push({path,options});return path.endsWith('/terrain-prediction')?prediction:history;},async client=>{
    const result=await call(client,'get_location_context',{dimension:'minecraft:overworld',x:-1,y:72,z:-17,seed:'-9007199254740993',generationVersion:'1.26.61.1',worldType:'DEFAULT',radius:64,historyRadius:8,includeSeedMap:false});
    assert.equal(result.isError,undefined);const data=result.structuredContent.data;
    assert.equal(data.status,'COMBINED');assert.deepEqual(data.prediction,prediction);assert.deepEqual(data.history,history);
    assert.deepEqual(data.location,{dimension:'minecraft:overworld',x:-1,y:72,z:-17});assert.equal(data.completeWorldCoverage,false);
    assert.equal(requests.length,2);assert.ok(requests.every(r=>r.path.startsWith(`/api/agent/servers/${serverId}/`)));
    assert.deepEqual(requests[0].options.body.at,{...data.location,radius:64,step:16});
    assert.equal(requests[0].options.body.seed,'-9007199254740993');
    assert.deepEqual(requests[1].options.query,{...data.location,radius:8});assert.equal(requests[1].options.body,undefined);
    const invalid=await call(client,'get_location_context',{dimension:'minecraft:overworld',x:0,z:0,worldType:'DEFAULT',seed:'1'});
    assert.equal(invalid.isError,true);assert.equal(requests.length,2);
  });
});

test('combined location tool exposes missing sources but fails closed on authorization, cancellation and invalid input',async()=>{
  const args={dimension:'minecraft:overworld',x:0,z:0,worldType:'DEFAULT',includeSeedMap:false};
  for(const status of ['NOT_CONFIGURED','UNSUPPORTED_WORLD_TYPE'])await fixture(async path=>path.endsWith('/terrain-prediction')?{status}:{status:'NO_RECORD',records:[]},async client=>{
    const data=(await call(client,'get_location_context',args)).structuredContent.data;
    assert.equal(data.status,'PARTIAL');assert.equal(data.prediction.status,status);assert.equal(data.history.status,'NO_RECORD');
  });
  for(const failPrediction of [true,false])await fixture(async path=>{
    if(path.endsWith('/terrain-prediction')===failPrediction)throw new ApiError('BACKEND_TIMEOUT');
    return {status:failPrediction?'HISTORY':'PREDICTED'};
  },async client=>{
    const data=(await call(client,'get_location_context',args)).structuredContent.data;
    assert.equal(data.status,'PARTIAL');assert.equal(data[failPrediction?'prediction':'history'].status,'UNAVAILABLE');
    assert.equal(data[failPrediction?'prediction':'history'].error,'BACKEND_TIMEOUT');
  });
  for(const code of ['AGENT_TOKEN_INVALID','PERMISSION_DENIED','REQUEST_CANCELLED','INVALID_REQUEST'])for(const failPrediction of [true,false])await fixture(async path=>{
    if(path.endsWith('/terrain-prediction')===failPrediction)throw new ApiError(code);
    return {status:'HISTORY',records:[{secret:'must not leak'}]};
  },async client=>{
    const result=await call(client,'get_location_context',args);
    assert.equal(result.isError,true);assert.equal(result.structuredContent.error,code);assert.equal(result.structuredContent.data,undefined);
    assert.ok(!JSON.stringify(result).includes('must not leak'));
  });
  await fixture(async()=>{throw new ApiError('BACKEND_TIMEOUT');},async client=>assert.equal((await call(client,'get_location_context',args)).isError,true));
});

test('seed-map context combines four bounded sources, preserves standalone tools, and fails closed on second-stage permission loss',async()=>{
  const args={dimension:'minecraft:overworld',x:-1,z:-17,seed:'1',generationVersion:'1.26.61.1',worldType:'DEFAULT'};
  const requests=[];let deny=false;
  await fixture(async(path,options)=>{
    requests.push({path,options});if(deny&&path.endsWith('/chunk-info'))throw new ApiError('PERMISSION_DENIED');
    if(path.endsWith('/structure-predictions'))return {status:'PREDICTED',candidates:[{structure:'village'}],truncated:true};
    if(path.endsWith('/chunk-info'))return {status:'CALCULATED',seedIndependent:true};
    return {status:path.endsWith('/terrain-prediction')?'PREDICTED':'NO_RECORD'};
  },async client=>{
    const result=(await call(client,'get_location_context',args)).structuredContent.data;
    assert.equal(result.status,'COMBINED');assert.equal(result.structures.truncated,true);assert.equal(result.chunks.seedIndependent,true);assert.equal(requests.length,4);
    assert.equal(requests[2].options.body.radius,2048);assert.equal(requests[2].options.body.limit,16);assert.equal(requests[2].options.body.y,undefined);
    assert.deepEqual(requests[3].options.query,{dimension:args.dimension,x:-1,z:-17,radius:2});
    const {seed,generationVersion,worldType,...chunkArgs}=args;
    assert.equal((await call(client,'get_chunk_info',chunkArgs)).isError,undefined);
    assert.equal((await call(client,'get_structure_predictions',args)).isError,undefined);
    const invalid=await call(client,'get_chunk_info',args);assert.equal(invalid.isError,true);
    deny=true;const failed=await call(client,'get_location_context',args);assert.equal(failed.isError,true);assert.equal(failed.structuredContent.error,'PERMISSION_DENIED');assert.equal(failed.structuredContent.data,undefined);
  });
});

test('lost world-query POST response retains one stable retry ID without automatic replay', async () => {
  const bodies = [];
  await fixture(async (_, { body }) => {
    bodies.push(body);
    if (bodies.length === 1) throw new ApiError('BACKEND_TIMEOUT');
    return { id: randomUUID(), status: 'READY', requestId: body.requestId };
  }, async client => {
    const failure = await call(client, 'get_world_state');
    assert.equal(failure.isError, true);
    assert.equal(bodies.length, 1);
    assert.equal(failure.structuredContent.recovery.requestId, bodies[0].requestId);
    const success = await call(client, 'get_world_state', { requestId: failure.structuredContent.recovery.requestId });
    assert.equal(success.structuredContent.data.status, 'READY');
    assert.deepEqual(bodies[0], bodies[1]);
  });
});

test('lost polling response preserves the original query and provides a read-only recovery', async () => {
  const id = randomUUID(), requestId = randomUUID(); let calls = 0;
  await fixture(async (_, options) => {
    calls++;
    if (options.body) {
      assert.equal(options.body.requestId, requestId);
      return { id, requestId, status: 'PENDING' };
    }
    throw new ApiError('BACKEND_UNREACHABLE');
  }, async client => {
    const result = await call(client, 'get_world_state', { requestId });
    assert.equal(result.isError, undefined);
    const data = result.structuredContent.data;
    assert.equal(data.id, id); assert.equal(data.status, 'PENDING');
    assert.equal(data.pollingError.error, 'BACKEND_UNREACHABLE');
    assert.deepEqual(data.recovery.arguments, { queryId: id });
    assert.equal(data.recovery.tool, 'get_world_query_result');
    assert.equal(calls, 2);
  });
});

test('permission failures and cancellation never return a misleading successful observation', async () => {
  for (const code of ['AGENT_TOKEN_INVALID', 'PERMISSION_DENIED', 'REQUEST_CANCELLED']) {
    let calls = 0;
    await fixture(async (_, options) => {
      calls++;
      if (options.body) return { id: randomUUID(), status: 'PENDING' };
      throw new ApiError(code);
    }, async client => {
      const result = await call(client, 'get_world_state');
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.error, code);
      assert.equal(result.structuredContent.recovery, undefined);
      assert.equal(calls, 2);
    });
  }
});

test('all six scheduling tools forward the caller requestId without leaking QQ identifiers into world queries', async () => {
  const key = 'xuid:12345', requestId = randomUUID();
  const coords = { dimension: 'minecraft:overworld', x: 1, y: 64, z: 2 };
  const bodies = [];
  await fixture(async (_, { body }) => {
    if (!body) return { bound: true, binding: { playerKey: key } };
    bodies.push(body); return { id: randomUUID(), status: 'READY' };
  }, async client => {
    for (const [name, args] of [
      ['get_world_state', {}], ['get_player_state', { playerKey: key }], ['get_qq_player_state', { qqId: '12345' }],
      ['inspect_block', coords], ['inspect_container', coords], ['scan_nearby', coords],
    ]) assert.equal((await call(client, name, { ...args, requestId })).isError, undefined);
    assert.equal(bodies.length, 6);
    for (const body of bodies) { assert.equal(body.requestId, requestId); assert.equal(body.qqId, undefined); }
  });
});

test('reversed dates and unexpected arguments are rejected before backend access', async () => {
  await fixture(() => assert.fail('invalid input reached backend'), async client => {
    const result = await call(client, 'get_player_statistics', { playerKey: 'xuid:12345', fromDate: '2026-11-06', toDate: '2026-11-01' });
    assert.equal(result.structuredContent.error, 'INVALID_DATE_RANGE');
    assert.equal((await call(client, 'get_world_state', { command: 'stop' })).isError, true);
  });
});

test('uncertain chat delivery reports the exact retry arguments and sends only once', async () => {
  let calls = 0;
  const args = { serverId, requestId: randomUUID(), text: '你好', ttlSeconds: 60 };
  await fixture(async () => { calls++; throw new ApiError('BACKEND_TIMEOUT'); }, async client => {
    const result = await call(client, 'send_chat_reply', args);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.recovery.tool, 'send_chat_reply');
    assert.deepEqual(result.structuredContent.recovery.arguments, args);
    assert.equal(calls, 1);
  });
});
