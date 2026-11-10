<script setup lang="ts">
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
 catch(e){if(seq===request&&!controller.signal.aborted)error.value=e instanceof Error?e.message:'运行状况读取失败'}
 finally{if(seq===request&&!disposed){loading.value=false;schedule()}}
}
function schedule(){clearTimeout(timer);timer=setTimeout(()=>{if(document.hidden)schedule();else void load()},15000)}
watch(()=>[props.scope,hours.value],()=>void load(true),{immediate:true})
onBeforeUnmount(()=>{disposed=true;++request;controller?.abort();clearTimeout(timer)})
const labels:Record<string,string>={NO_DATA:'等待首次采集',HEALTHY:'运行流畅',SLOW:'流畅度下降',STALE:'运行数据中断',TICK_STALLED:'游戏长时间未推进',STOPPED:'采集已停止'}
const fresh=computed(()=>!!data.value&&['HEALTHY','SLOW','TICK_STALLED'].includes(data.value.state)&&!error.value)
const latest=computed(()=>data.value?.latest)
const number=(v:number|null|undefined,d=1)=>v==null?'—':v.toFixed(d)
const memory=(v:number|null|undefined)=>v==null?'—':(v/1073741824).toFixed(2)+' GB'
const duration=(ms:number|undefined)=>ms==null?'—':`${Math.floor(ms/3600000)} 小时 ${Math.floor(ms/60000)%60} 分`
const time=(v:string)=>new Date(v).toLocaleString('zh-CN',{hour12:false})
function chart(key:RuntimeMetric,name:string,max?:number):EChartsOption{
 const values=data.value?runtimeSeries(data.value,key):[]
 return {tooltip:{trigger:'axis',renderMode:'richText'},grid:{left:58,right:20,top:25,bottom:40},xAxis:{type:'time'},yAxis:{type:'value',min:0,max,name,axisLabel:{formatter:compactChartNumber,hideOverlap:true}},series:[{name,type:'line',data:values,connectNulls:false,showSymbol:true,symbolSize:5,smooth:false,lineStyle:{width:2},areaStyle:{opacity:.08}}]}
}
const hostMemoryPercent=computed(()=>latest.value?.hostMemoryTotalBytes&&latest.value.hostMemoryAvailableBytes!=null?(1-latest.value.hostMemoryAvailableBytes/latest.value.hostMemoryTotalBytes)*100:null)
const speed=(v:number|null|undefined)=>v==null?'—':v>=1048576?(v/1048576).toFixed(2)+' MiB/s':(v/1024).toFixed(1)+' KiB/s'
const hostCharts=computed(()=>[
 {title:'整机 CPU',help:'游戏进程与其他程序合计占用。',option:chart('hostCpuPercent','%',100)},
 {title:'整机内存使用率',help:'物理内存已用占比，与进程内存口径不同。',option:chart('hostMemoryUsedPercent','%',100)},
 {title:'主机网络接收',help:'已启用物理网卡合计，单位字节/秒。',option:chart('hostNetworkReceiveBps','B/s')},
 {title:'主机网络发送',help:'不重复累计虚拟或 VPN 网卡。',option:chart('hostNetworkSendBps','B/s')},
])
const charts=computed(()=>[
 {title:'游戏流畅度',help:'越接近 20 越流畅；低于 18 时提醒。',option:chart('tps','TPS',20)},
 {title:'游戏进程 CPU',help:'占这台游戏机器全部逻辑核心的比例。',option:chart('cpuPercent','%',100)},
 {title:'游戏进程内存',help:'实际驻留在物理内存中的大小。',option:chart('memoryMiB','MiB')},
 {title:'在线人数',help:'每个汇总时间段内观察到的最高人数。',option:chart('players','人')},
 {title:'最长游戏帧间隔',help:'正常节奏约 50 毫秒；这不是单帧执行耗时。',option:chart('maxTickIntervalMillis','毫秒')},
])
</script>
<template>
 <div class="runtime-view">
  <section v-if="scope==='all'" class="project-panel"><h2>选择要查看的服务器</h2><p class="project-muted">每台游戏服分别记录运行状态。</p><div class="runtime-servers"><button v-for="s in servers" :key="s.id" @click="emit('select',s.id)">{{s.name}}</button><p v-if="!servers.length">创建服务器档案并安装采集插件后，这里会开始记录。</p></div></section>
  <template v-else>
   <section class="project-panel runtime-heading"><div><h2>{{data?.serverName??'服务器运行状况'}}</h2><p>先看整台游戏主机，再看游戏进程，比较资源占用与流畅度。</p></div><div class="runtime-actions"><label>查看范围<select v-model.number="hours"><option :value="1">最近 1 小时</option><option :value="6">最近 6 小时</option><option :value="24">最近 24 小时</option><option :value="168">最近 7 天</option></select></label><button :disabled="loading" @click="load()">{{loading?'正在读取…':'刷新状态'}}</button></div></section>
   <p v-if="error" role="alert" class="project-error">{{error}} · 页面保留的是上次读取结果。</p>
   <template v-if="data">
    <section class="runtime-status" :class="{warning:!fresh||data.state!=='HEALTHY'}"><strong>{{error?'暂时无法读取':labels[data.state]??data.state}}</strong><span v-if="latest">最近采样：{{time(latest.at)}} · 约每 15 秒刷新页面</span><span v-else>游戏服升级采集插件至 0.37.0 后，运行几分钟即可看到曲线。</span><p v-if="data.state==='STALE'">暂时收不到新数据，可能是停服、网络中断或插件异常，不能据此认定服务器崩溃。</p><p v-if="data.state==='TICK_STALLED'">采集通道仍有响应，但游戏已至少 5 秒没有新的 tick；在线人数是最后一次观察值。</p></section>
    <section class="project-panel"><h2>整台游戏主机</h2><p class="project-muted">这里统计运行游戏的 Windows 电脑，不是 NAS。采集插件运行期间约每 10 秒采样；停服后不继续监控。</p>
     <p v-if="latest?.hostLogicalProcessors==null" class="project-muted">整机 CPU、磁盘与网络需要采集器 0.37.0。已有主机内存可直接查看，缺少的数据不补零。</p>
     <div class="runtime-cards">
      <article><span>整机 CPU</span><strong>{{fresh?number(latest?.hostCpuPercent):'—'}} <small>%</small></strong><p>{{latest?.hostLogicalProcessors??'—'}} 个逻辑核心 · 所有程序合计</p></article>
      <article><span>整机内存使用</span><strong>{{fresh?number(hostMemoryPercent):'—'}} <small>%</small></strong><p>总计 {{memory(latest?.hostMemoryTotalBytes)}} · 可用 {{fresh?memory(latest?.hostMemoryAvailableBytes):'—'}}</p></article>
      <article><span>网络接收</span><strong>{{fresh?speed(latest?.hostNetworkReceiveBps):'—'}}</strong><p>启用的物理网卡合计</p></article>
      <article><span>网络发送</span><strong>{{fresh?speed(latest?.hostNetworkSendBps):'—'}}</strong><p>虚拟网卡不重复相加</p></article>
     </div>
     <div class="disk-list"><article v-for="disk in latest?.hostDisks??[]" :key="disk.drive"><strong>{{disk.drive}} 固定磁盘</strong><p>总计 {{memory(disk.totalBytes)}} · {{fresh?'可用':'上次可用'}} {{memory(disk.availableBytes)}}</p><progress max="100" :value="(1-disk.availableBytes/disk.totalBytes)*100" :aria-label="disk.drive+'磁盘已用比例'"/></article></div>
     <div v-if="data.points.length" class="runtime-charts"><section v-for="c in hostCharts" :key="c.title"><h3>{{c.title}}</h3><p class="project-muted">{{c.help}}</p><DataChart :option="c.option" :label="c.title+'历史曲线'"/></section></div>
    </section>
    <h2>游戏服务器进程</h2>
    <div class="runtime-cards">
     <article><span>游戏流畅度</span><strong>{{fresh?number(latest?.tps):'—'}} <small>TPS</small></strong><p>满速约 20</p></article>
     <article><span>游戏进程 CPU</span><strong>{{fresh?number(latest?.cpuPercent):'—'}} <small>%</small></strong><p>不代表整机总占用</p></article>
     <article><span>游戏进程内存</span><strong>{{fresh?memory(latest?.workingSetBytes):'—'}}</strong><p>主机剩余：{{fresh?memory(latest?.hostMemoryAvailableBytes):'—'}}</p></article>
     <article><span>在线人数</span><strong>{{fresh&&data.state!=='TICK_STALLED'?latest?.players:'—'}} <small>人</small></strong><p>以游戏服观察为准</p></article>
    </div>
    <p class="project-muted">{{fresh?'本次采集已运行：'+duration(latest?.uptimeMillis):'数据中断时不把旧数值当作当前状态。'}} · 图表从已有采样附近开始显示，中断时留空。</p>
    <details class="project-muted"><summary>这些数值怎么看？</summary><p>{{data.notice}}</p></details>
    <div v-if="data.points.length" class="runtime-charts"><section v-for="c in charts" :key="c.title" class="project-panel"><h3>{{c.title}}</h3><p class="project-muted">{{c.help}}</p><DataChart :option="c.option" :label="c.title+'历史曲线'"/></section></div>
    <p v-else class="project-panel">这个时间范围内还没有运行采样。不会用示例数据填充图表。</p>
    <section class="project-panel"><h3>值得留意的时间点</h3><p class="project-muted">长帧、低流畅度、数据中断和采集重新启动。它们只是排查线索，不是故障原因结论。</p><ol v-if="data.events.length" class="runtime-events"><li v-for="(event,i) in data.events" :key="i"><time>{{time(event.at)}}</time><span>{{event.message}}</span></li></ol><p v-else>当前范围内没有记录到这些情况。</p><p v-if="data.eventsTruncated">仅显示最近 100 个时间点，可缩小时间范围查看。</p></section>
   </template>
  </template>
 </div>
</template>
<style scoped>
.disk-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin:16px 0}.disk-list article{padding:14px;background:#f1f6f3;border-radius:10px}.disk-list p{font-size:12px;color:#60786b}.disk-list progress{width:100%;accent-color:#26976d}.runtime-view{display:grid;gap:16px}.runtime-heading{display:flex;justify-content:space-between;align-items:center;gap:16px}.runtime-heading h2{margin:0}.runtime-heading p{color:#647b70;margin:8px 0 0}.runtime-actions,.runtime-servers{display:flex;flex-wrap:wrap;align-items:end;gap:10px}.runtime-actions label{display:grid;gap:6px;font-size:13px}.runtime-actions select{padding:9px;border:1px solid #cbded3;border-radius:8px;background:#fff;color:#21533f}.runtime-status{display:flex;align-items:center;flex-wrap:wrap;gap:12px;background:#e5f5e9;border:1px solid #c3e6ca;border-radius:12px;padding:18px;color:#17613c}.runtime-status span{font-size:13px}.runtime-status.warning{background:#fff3df;border-color:#f0d7ae;color:#7d5521}.runtime-status p{flex-basis:100%;margin:0;font-size:13px}.runtime-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.runtime-cards article{padding:20px;background:#e9f5ec;border:1px solid #cbe5d0;border-radius:14px}.runtime-cards article:nth-child(2){background:#eaf1ff;border-color:#cdddf7}.runtime-cards article:nth-child(3){background:#f2edff;border-color:#ded2f8}.runtime-cards article:nth-child(4){background:#fff3df;border-color:#f1d8ae}.runtime-cards span{font-size:13px}.runtime-cards strong{display:block;font-size:27px;color:#18533b;margin-top:10px}.runtime-cards small{font-size:14px}.runtime-cards p{font-size:12px;margin-bottom:0;color:#687a70}.runtime-charts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.runtime-charts section{min-width:0}.runtime-events{list-style:none;padding:0;max-height:420px;overflow:auto}.runtime-events li{padding:12px 0;border-bottom:1px solid #e4eee8;display:flex;gap:20px;font-size:13px}.runtime-events time{flex-shrink:0;color:#60786b}@media(max-width:900px){.runtime-cards{grid-template-columns:repeat(2,minmax(0,1fr))}.runtime-charts{grid-template-columns:1fr}}@media(max-width:600px){.runtime-heading{align-items:start;flex-direction:column}.runtime-cards article{padding:14px}.runtime-cards strong{font-size:23px}.runtime-events li{flex-direction:column;gap:6px}}
</style>
