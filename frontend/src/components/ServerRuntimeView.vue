<script setup lang="ts">
import { t, formatLocale } from '../i18n'

import {computed,onBeforeUnmount,ref,watch} from 'vue'
import {api,type ServerArchive} from '../api'
import DataChart from './DataChart.vue'
import {compactChartNumber} from '../chartNumbers'
import type {EChartsOption} from 'echarts'
import {runtimeSeries,type RuntimeMetric} from '../runtimeSeries'
const props=defineProps<{scope:string;servers:ServerArchive[]}>()
const emit=defineEmits<{select:[id:string]}>()
interface Sample {at:string;receivedAt:string;uptimeMillis:number;tps:number|null;cpuPercent:number|null;workingSetBytes:number|null;privateBytes:number|null;hostMemoryTotalBytes:number|null;hostMemoryAvailableBytes:number|null;players:number;lastTickAt:string|null;maxTickIntervalMillis:number;stopped:boolean;hostCpuPercent:number|null;hostLogicalProcessors:number|null;hostNetworkReceiveBps:number|null;hostNetworkSendBps:number|null;hostDisks:{drive:string;totalBytes:number;availableBytes:number}[]|null}
interface Point {at:string;samples:number;tps:number|null;cpuPercent:number|null;memoryMiB:number|null;players:number;maxTickIntervalMillis:number;hostCpuPercent:number|null;hostMemoryUsedPercent:number|null;hostNetworkReceiveBps:number|null;hostNetworkSendBps:number|null}
interface Report {serverName:string;state:string;generatedAt:string;from:string;to:string;bucketSeconds:number;latest:Sample|null;points:Point[];events:{at:string;type:string;message:string}[];eventsTruncated:boolean;notice:string}
const data=ref<Report>(),hours=ref(1),error=ref(''),loading=ref(false)
let controller:AbortController|undefined,timer:ReturnType<typeof setTimeout>|undefined,request=0,disposed=false
async function load(reset=false){
 clearTimeout(timer);controller?.abort();const seq=++request;if(reset)data.value=undefined
 if(props.scope==='all'){loading.value=false;return}
 controller=new AbortController();loading.value=true
 try{const result=await api<Report>(`/servers/${props.scope}/runtime?hours=${hours.value}`,{signal:controller.signal});if(seq===request){data.value=result;error.value=''}}
 catch(e){if(seq===request&&!controller.signal.aborted)error.value=e instanceof Error?e.message:t('m1366')}
 finally{if(seq===request&&!disposed){loading.value=false;schedule()}}
}
function schedule(){clearTimeout(timer);timer=setTimeout(()=>{if(document.hidden)schedule();else void load()},15000)}
watch(()=>[props.scope,hours.value],()=>void load(true),{immediate:true})
onBeforeUnmount(()=>{disposed=true;++request;controller?.abort();clearTimeout(timer)})
const labels:Record<string,string>={NO_DATA:t('m0836'),HEALTHY:t('m0831'),SLOW:t('m0832'),STALE:t('m1367'),TICK_STALLED:t('m1368'),STOPPED:t('m0835')}
const fresh=computed(()=>!!data.value&&['HEALTHY','SLOW','TICK_STALLED'].includes(data.value.state)&&!error.value)
const latest=computed(()=>data.value?.latest)
const number=(v:number|null|undefined,d=1)=>v==null?'—':v.toFixed(d)
const memory=(v:number|null|undefined)=>v==null?'—':(v/1073741824).toFixed(2)+' GB'
const duration=(ms:number|undefined)=>ms==null?'—':t('m0273', [Math.floor(ms/3600000), Math.floor(ms/60000)%60])
const time=(v:string)=>new Date(v).toLocaleString(formatLocale,{hour12:false})
function chart(key:RuntimeMetric,name:string,max?:number):EChartsOption{
 const values=data.value?runtimeSeries(data.value,key):[]
 return {tooltip:{trigger:'axis',renderMode:'richText'},grid:{left:58,right:20,top:25,bottom:40},xAxis:{type:'time'},yAxis:{type:'value',min:0,max,name,axisLabel:{formatter:compactChartNumber,hideOverlap:true}},series:[{name,type:'line',data:values,connectNulls:false,showSymbol:true,symbolSize:5,smooth:false,lineStyle:{width:2},areaStyle:{opacity:.08}}]}
}
const hostMemoryPercent=computed(()=>latest.value?.hostMemoryTotalBytes&&latest.value.hostMemoryAvailableBytes!=null?(1-latest.value.hostMemoryAvailableBytes/latest.value.hostMemoryTotalBytes)*100:null)
const speed=(v:number|null|undefined)=>v==null?'—':v>=1048576?(v/1048576).toFixed(2)+' MiB/s':(v/1024).toFixed(1)+' KiB/s'
const hostCharts=computed(()=>[
 {title:t('m0728'),help:t('m1369'),option:chart('hostCpuPercent','%',100)},
 {title:t('m1370'),help:t('m1371'),option:chart('hostMemoryUsedPercent','%',100)},
 {title:t('m1372'),help:t('m1373'),option:chart('hostNetworkReceiveBps','B/s')},
 {title:t('m1374'),help:t('m1375'),option:chart('hostNetworkSendBps','B/s')},
])
const charts=computed(()=>[
 {title:t('m0730'),help:t('m1376'),option:chart('tps','TPS',20)},
 {title:t('m0731'),help:t('m1377'),option:chart('cpuPercent','%',100)},
 {title:t('m0732'),help:t('m1378'),option:chart('memoryMiB','MiB')},
 {title:t('m1379'),help:t('m1380'),option:chart('players',t('m1381'))},
 {title:t('m1382'),help:t('m1383'),option:chart('maxTickIntervalMillis',t('m0734'))},
])
</script>
<template>
 <div class="runtime-view">
  <section v-if="scope==='all'" class="project-panel"><h2>{{ t('m1384') }}</h2><p class="project-muted">{{ t('m1385') }}</p><div class="runtime-servers"><button v-for="s in servers" :key="s.id" @click="emit('select',s.id)">{{s.name}}</button><p v-if="!servers.length">{{ t('m1386') }}</p></div></section>
  <template v-else>
   <section class="project-panel runtime-heading"><div><h2>{{data?.serverName??t('m0840')}}</h2><p>{{ t('m1387') }}</p></div><div class="runtime-actions"><label>{{ t('m1388') }}<select v-model.number="hours"><option :value="1">{{ t('m1389') }}</option><option :value="6">{{ t('m1390') }}</option><option :value="24">{{ t('m1391') }}</option><option :value="168">{{ t('m1392') }}</option></select></label><button :disabled="loading" @click="load()">{{loading?t('m1393'):t('m0615')}}</button></div></section>
   <p v-if="error" role="alert" class="project-error">{{ t('m1394', [error]) }}</p>
   <template v-if="data">
    <section class="runtime-status" :class="{warning:!fresh||data.state!=='HEALTHY'}"><strong>{{error?t('m0830'):labels[data.state]??data.state}}</strong><span v-if="latest">{{ t('m1395', [time(latest.at)]) }}</span><span v-else>{{ t('m1396') }}</span><p v-if="data.state==='STALE'">{{ t('m1397') }}</p><p v-if="data.state==='TICK_STALLED'">{{ t('m1398') }}</p></section>
    <section class="project-panel"><h2>{{ t('m1399') }}</h2><p class="project-muted">{{ t('m1400') }}</p>
     <p v-if="latest?.hostLogicalProcessors==null" class="project-muted">{{ t('m1401') }}</p>
     <div class="runtime-cards">
      <article><span>{{ t('m0728') }}</span><strong>{{fresh?number(latest?.hostCpuPercent):'—'}} <small>%</small></strong><p>{{ t('m1402', [latest?.hostLogicalProcessors??'—']) }}</p></article>
      <article><span>{{ t('m0729') }}</span><strong>{{fresh?number(hostMemoryPercent):'—'}} <small>%</small></strong><p>{{ t('m1403', [memory(latest?.hostMemoryTotalBytes), fresh?memory(latest?.hostMemoryAvailableBytes):'—']) }}</p></article>
      <article><span>{{ t('m1404') }}</span><strong>{{fresh?speed(latest?.hostNetworkReceiveBps):'—'}}</strong><p>{{ t('m1405') }}</p></article>
      <article><span>{{ t('m1406') }}</span><strong>{{fresh?speed(latest?.hostNetworkSendBps):'—'}}</strong><p>{{ t('m1407') }}</p></article>
     </div>
     <div class="disk-list"><article v-for="disk in latest?.hostDisks??[]" :key="disk.drive"><strong>{{ t('m1408', [disk.drive]) }}</strong><p>{{ t('m1411', [memory(disk.totalBytes), fresh?t('m1409'):t('m1410'), memory(disk.availableBytes)]) }}</p><progress max="100" :value="(1-disk.availableBytes/disk.totalBytes)*100" :aria-label="disk.drive+t('m1412')"/></article></div>
     <div v-if="data.points.length" class="runtime-charts"><section v-for="c in hostCharts" :key="c.title"><h3>{{c.title}}</h3><p class="project-muted">{{c.help}}</p><DataChart :option="c.option" :label="c.title+t('m1413')"/></section></div>
    </section>
    <h2>{{ t('m1414') }}</h2>
    <div class="runtime-cards">
     <article><span>{{ t('m0730') }}</span><strong>{{fresh?number(latest?.tps):'—'}} <small>TPS</small></strong><p>{{ t('m1415') }}</p></article>
     <article><span>{{ t('m0731') }}</span><strong>{{fresh?number(latest?.cpuPercent):'—'}} <small>%</small></strong><p>{{ t('m1416') }}</p></article>
     <article><span>{{ t('m0732') }}</span><strong>{{fresh?memory(latest?.workingSetBytes):'—'}}</strong><p>{{ t('m1417', [fresh?memory(latest?.hostMemoryAvailableBytes):'—']) }}</p></article>
     <article><span>{{ t('m1379') }}</span><strong>{{fresh&&data.state!=='TICK_STALLED'?latest?.players:'—'}} <small>{{ t('m1381') }}</small></strong><p>{{ t('m1418') }}</p></article>
    </div>
    <p class="project-muted">{{ t('m1421', [fresh?t('m1419')+duration(latest?.uptimeMillis):t('m1420')]) }}</p>
    <details class="project-muted"><summary>{{ t('m1422') }}</summary><p>{{data.notice}}</p></details>
    <div v-if="data.points.length" class="runtime-charts"><section v-for="c in charts" :key="c.title" class="project-panel"><h3>{{c.title}}</h3><p class="project-muted">{{c.help}}</p><DataChart :option="c.option" :label="c.title+t('m1413')"/></section></div>
    <p v-else class="project-panel">{{ t('m1423') }}</p>
    <section class="project-panel"><h3>{{ t('m1424') }}</h3><p class="project-muted">{{ t('m1425') }}</p><ol v-if="data.events.length" class="runtime-events"><li v-for="(event,i) in data.events" :key="i"><time>{{time(event.at)}}</time><span>{{event.message}}</span></li></ol><p v-else>{{ t('m1426') }}</p><p v-if="data.eventsTruncated">{{ t('m1427') }}</p></section>
   </template>
  </template>
 </div>
</template>
<style scoped>
.disk-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin:16px 0}.disk-list article{padding:14px;background:#f1f6f3;border-radius:10px}.disk-list p{font-size:12px;color:#60786b}.disk-list progress{width:100%;accent-color:#26976d}.runtime-view{display:grid;gap:16px}.runtime-heading{display:flex;justify-content:space-between;align-items:center;gap:16px}.runtime-heading h2{margin:0}.runtime-heading p{color:#647b70;margin:8px 0 0}.runtime-actions,.runtime-servers{display:flex;flex-wrap:wrap;align-items:end;gap:10px}.runtime-actions label{display:grid;gap:6px;font-size:13px}.runtime-actions select{padding:9px;border:1px solid #cbded3;border-radius:8px;background:#fff;color:#21533f}.runtime-status{display:flex;align-items:center;flex-wrap:wrap;gap:12px;background:#e5f5e9;border:1px solid #c3e6ca;border-radius:12px;padding:18px;color:#17613c}.runtime-status span{font-size:13px}.runtime-status.warning{background:#fff3df;border-color:#f0d7ae;color:#7d5521}.runtime-status p{flex-basis:100%;margin:0;font-size:13px}.runtime-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.runtime-cards article{padding:20px;background:#e9f5ec;border:1px solid #cbe5d0;border-radius:14px}.runtime-cards article:nth-child(2){background:#eaf1ff;border-color:#cdddf7}.runtime-cards article:nth-child(3){background:#f2edff;border-color:#ded2f8}.runtime-cards article:nth-child(4){background:#fff3df;border-color:#f1d8ae}.runtime-cards span{font-size:13px}.runtime-cards strong{display:block;font-size:27px;color:#18533b;margin-top:10px}.runtime-cards small{font-size:14px}.runtime-cards p{font-size:12px;margin-bottom:0;color:#687a70}.runtime-charts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.runtime-charts section{min-width:0}.runtime-events{list-style:none;padding:0;max-height:420px;overflow:auto}.runtime-events li{padding:12px 0;border-bottom:1px solid #e4eee8;display:flex;gap:20px;font-size:13px}.runtime-events time{flex-shrink:0;color:#60786b}@media(max-width:900px){.runtime-cards{grid-template-columns:repeat(2,minmax(0,1fr))}.runtime-charts{grid-template-columns:1fr}}@media(max-width:600px){.runtime-heading{align-items:start;flex-direction:column}.runtime-cards article{padding:14px}.runtime-cards strong{font-size:23px}.runtime-events li{flex-direction:column;gap:6px}}
</style>
