<script setup lang="ts">
import { weekdays, systemMessage, t, formatLocale } from '../i18n'

import {computed,ref,shallowRef,watch,onBeforeUnmount} from 'vue'
import type {EChartsOption} from 'echarts'
import {api} from '../api'
import type {Exploration,ExplorationDetails} from '../exploration'
import {gameName} from '../gameNames'
import {compactChartNumber} from '../chartNumbers'
import DataChart from './DataChart.vue'
import { calendarDays, relativeActivity } from '../chartData'

const props=defineProps<{tab:string;server:string;base:Exploration;snapshots:Map<string,ExplorationDetails>}>()
const data=shallowRef<ExplorationDetails>(),error=ref(''),busy=ref(false),runtimeMetric=ref('host_cpu'),chosen=ref<string[]>([])
let controller:AbortController|undefined
const section=computed(()=>({river:'daily',bubble:'players',radar:'players',box:'runtime',timeline:'milestones'} as Record<string,string>)[props.tab])
const snapshots=props.snapshots
async function load(){
 controller?.abort();const request=new AbortController();controller=request;data.value=undefined;busy.value=true;error.value=''
 try {
  if(!section.value){data.value={generatedAt:props.base.generatedAt,from:props.base.from,to:props.base.to,zone:props.base.zone,serverName:'',daily:[],players:[],runtime:[],milestones:[],notices:props.base.notices};return}
  const params=new URLSearchParams({serverId:props.server,from:props.base.from,to:props.base.to,part:section.value})
  const key=params.toString(),saved=snapshots.get(key)
  const result=saved&&Date.parse(saved.generatedAt)>Date.now()-120_000?saved:await api<ExplorationDetails>('/statistics/exploration/extended?'+params,{signal:request.signal})
  if(!request.signal.aborted){data.value=result;snapshots.set(key,result);while(snapshots.size>8)snapshots.delete(snapshots.keys().next().value!);chosen.value=result.players.slice(0,3).map(p=>p.player)}
 }catch(e){if(!request.signal.aborted)error.value=e instanceof Error?e.message:t('m0708')}
 finally{if(controller===request)busy.value=false}
}
watch(()=>[props.server,props.base.from,props.base.to,props.base.generatedAt,section.value],load,{immediate:true})
onBeforeUnmount(()=>controller?.abort())
const tip={trigger:'item' as const,renderMode:'richText' as const,confine:true}
const days=computed(()=>calendarDays(props.base.from,props.base.to))
const activities=[{name:t('m0709'),keys:['blocks.placed'],unit:t('m0710'),scale:1},{name:t('m0686'),keys:['blocks.mined'],unit:t('m0710'),scale:1},{name:t('m0711'),keys:['crops.planted'],unit:t('m0710'),scale:1},{name:t('m0712'),keys:['crops.harvested'],unit:t('m0710'),scale:1},{name:t('m0713'),keys:['travel.walk_millimeters','travel.swim_millimeters','travel.fly_millimeters','travel.glide_millimeters','travel.vehicle_millimeters'],unit:t('m0714'),scale:.001}]
const riverData=computed(()=>activities.map(a=>{const raw=days.value.map(day=>{const rows=data.value?.daily.filter(r=>r.day===day&&a.keys.includes(r.metric))??[];return rows.length?rows.reduce((s,r)=>s+Number(r.amount),0)*a.scale:null});return {...a,raw,values:relativeActivity(raw)}}))
const river=computed<EChartsOption>(()=>({
 tooltip:{...tip,trigger:'axis',formatter:(params:any)=>{
  const points=Array.isArray(params)?params:[params],day=points[0]?.axisValue??'';
  return [day,...riverData.value.map(series=>{const value=series.raw[days.value.indexOf(day)];return `${series.name}: ${value==null?t('chart_no_record'):value.toLocaleString(formatLocale)+' '+series.unit}`})].join('\n')
 }},legend:{type:'scroll',top:0},grid:{left:12,right:18,top:68,bottom:24,containLabel:true},
 xAxis:{type:'category',data:days.value,boundaryGap:false,axisLabel:{hideOverlap:true,formatter:(v:string)=>v.slice(5)}},
 yAxis:{type:'value',min:0,max:100,interval:25,name:t('chart_relative')},
 series:riverData.value.filter(series=>series.raw.some(value=>value!=null)).map(series=>({name:series.name,type:'line',data:series.values,connectNulls:false,smooth:false,symbolSize:7}))
}))
const clockRows=computed(()=>Array.from({length:168},(_,i)=>{const hour=i%24,weekday=Math.floor(i/24);return [hour,weekday,(props.base.hours.find(r=>r.hour===hour&&r.weekday===weekday)?.millis??0)/3600000]}))
const clock=computed<EChartsOption>(()=>({tooltip:{...tip,formatter:(p:any)=>t('m0721', [weekdays[p.value[1]], p.value[0], p.value[2]>0?t('m0718')+p.value[2].toFixed(2)+t('m0719'):t('m0720')])},visualMap:{min:0,max:Math.max(1,...clockRows.value.map(r=>r[2]!)),dimension:2,orient:'horizontal',left:'center',bottom:0,inRange:{color:['#edf5f0','#76cbb2','#15745c']}},series:[{type:'custom',coordinateSystem:'none',data:clockRows.value,renderItem:(_params:any,api:any)=>{const hour=Number(api.value(0)),day=Number(api.value(1)),size=Math.min(api.getWidth()-70,api.getHeight()-105),outer=size/2,inner=outer*.22,step=(outer-inner)/7,cx=api.getWidth()/2,cy=(api.getHeight()-30)/2;const start=hour*Math.PI/12-Math.PI/2,end=(hour+1)*Math.PI/12-Math.PI/2,children:any[]=[{type:'sector',shape:{cx,cy,r0:inner+day*step,r:inner+(day+1)*step-1,startAngle:start+.006,endAngle:end-.006},style:{fill:api.visual('color')}}];if(day===6&&hour%3===0)children.push({type:'text',style:{x:cx+Math.cos(start)*(outer+18),y:cy+Math.sin(start)*(outer+18),text:String(hour),align:'center',verticalAlign:'middle',fill:'#45665a',fontSize:12}});return {type:'group',children}}}]}))
const maxMined=computed(()=>Math.max(1,...(data.value?.players??[]).map(p=>Number(p.mined))))
const bubble=computed<EChartsOption>(()=>({tooltip:{...tip,formatter:(p:any)=>t('m0722', [p.data.name, p.value[0].toFixed(2), p.value[1].toLocaleString(formatLocale), p.value[2].toLocaleString(formatLocale)])},grid:{left:65,right:35,top:35,bottom:55},xAxis:{type:'value',name:t('m0723'),nameLocation:'middle',nameGap:30,min:0,axisLabel:{hideOverlap:true}},yAxis:{type:'value',name:t('m0724'),minInterval:1,axisLabel:{formatter:compactChartNumber,hideOverlap:true}},dataZoom:[{type:'inside',filterMode:'none'}],series:[{type:'scatter',data:data.value?.players.map(p=>({name:p.name,value:[Number(p.online)/3600000,Number(p.placed),Number(p.mined)]})),symbolSize:(v:any)=>12+Math.min(48,Math.sqrt(v[2]/maxMined.value)*48),itemStyle:{opacity:.65},emphasis:{label:{show:true,formatter:'{b}'}}}]}))
function compactBranches(rows:any[]):any[]{const sum=(node:any):number=>node.children?node.children.reduce((n:number,c:any)=>n+sum(c),0):Number(node.value);const sorted=rows.map(n=>({...n,value:sum(n)})).sort((a,b)=>b.value-a.value),top=sorted.slice(0,8).map(n=>n.children?{...n,children:compactBranches(n.children)}:n);if(sorted.length>8)top.push({name:t('m0725'),value:sorted.slice(8).reduce((n,c)=>n+c.value,0)});return top}
const sunburst=computed<EChartsOption>(()=>{const projects=new Map<string,any>();for(const c of props.base.contributions.filter(c=>c.operation==='PLACE')){let project=projects.get(c.project);if(!project){project={name:c.project_name,players:new Map()};projects.set(c.project,project)}let player=project.players.get(c.player);if(!player){player={name:c.player_name,blocks:new Map()};project.players.set(c.player,player)}player.blocks.set(c.block,(player.blocks.get(c.block)??0)+Number(c.value))}const top=[...projects.values()].map(p=>({name:p.name,children:[...p.players.values()].map((u:any)=>({name:u.name,children:[...u.blocks].map(([b,v]:any)=>({name:gameName(b,'block')??b,value:v})).sort((a,b)=>b.value-a.value)}))}));return {tooltip:{...tip,formatter:(p:any)=>t('m0726', [p.treePathInfo.slice(1).map((n:any)=>n.name).join(' → '), Number(p.value??0).toLocaleString(formatLocale)])},series:[{type:'sunburst',radius:['8%','92%'],nodeClick:'rootToNode',sort:'desc',label:{rotate:'tangential',minAngle:24,fontSize:11,width:60,overflow:'truncate'},data:[{name:data.value?.serverName??t('m0727'),label:{rotate:0,formatter:t('m0727'),fontSize:11},children:compactBranches(top)}]}]}})
const runtimeLabels:Record<string,[string,string]>={host_cpu:[t('m0728'),'%'],host_memory:[t('m0729'),'%'],tps:[t('m0730'),'TPS'],cpu:[t('m0731'),'%'],memory:[t('m0732'),'MiB'],interval:[t('m0733'),t('m0734')]}
const runtimeRows=computed(()=>data.value?.runtime.filter(r=>r.metric===runtimeMetric.value)??[])
const box=computed<EChartsOption>(()=>({tooltip:{...tip,formatter:(p:any)=>{const r=runtimeRows.value[p.dataIndex];return r?t('m0735', [r.day, r.samples.toLocaleString(formatLocale), r.maximum.toFixed(2), r.q3.toFixed(2), r.median.toFixed(2), r.q1.toFixed(2), r.minimum.toFixed(2), runtimeLabels[r.metric]?.[1]??'']):''}},grid:{left:62,right:25,top:35,bottom:55},xAxis:{type:'category',data:runtimeRows.value.map(r=>r.day.slice(5)),axisLabel:{hideOverlap:true}},yAxis:{type:'value',min:0,name:runtimeLabels[runtimeMetric.value]?.[1],axisLabel:{formatter:compactChartNumber,hideOverlap:true}},series:[{type:'boxplot',data:runtimeRows.value.map(r=>[r.minimum,r.q1,r.median,r.q3,r.maximum]),itemStyle:{color:'#c7e7d9',borderColor:'#238464'}}]}))
const eventLabels:Record<string,string>={SERVER_START:t('m0736'),PROJECT_START:t('m0737'),PROJECT_END:t('m0738'),BACKUP:t('m0739')}
const eventTime=(at:string)=>new Intl.DateTimeFormat(formatLocale,{timeZone:props.base.zone,dateStyle:'short',timeStyle:'short',hour12:false}).format(new Date(at))
const timeline=computed<EChartsOption>(()=>({tooltip:{...tip,formatter:(p:any)=>`${p.data.name}\n${eventLabels[p.data.kind]}${p.data.revision?t('m0740')+p.data.revision+t('m0741'):''}\n${eventTime(p.data.at)}`},grid:{left:110,right:30,top:30,bottom:80},xAxis:{type:'time',axisLabel:{hideOverlap:true,formatter:(v:number)=>new Intl.DateTimeFormat(formatLocale,{timeZone:props.base.zone,month:'2-digit',day:'2-digit'}).format(v)}},yAxis:{type:'category',data:Object.values(eventLabels),axisLabel:{width:95,overflow:'truncate'}},dataZoom:[{type:'slider',bottom:10},{type:'inside'}],series:[{type:'scatter',symbol:'diamond',symbolSize:14,data:data.value?.milestones.map(e=>({...e,value:[Date.parse(e.at),eventLabels[e.kind]],itemStyle:{color:['#259875','#728bde','#b18ada','#e5ad51'][Object.keys(eventLabels).indexOf(e.kind)]}}))}]}))
const radarAxes=[['placed',t('m0709')],['mined',t('m0686')],['planted',t('m0711')],['harvested',t('m0712')],['travel',t('m0713')],['chat',t('m0742')]] as const
const radar=computed<EChartsOption>(()=>{const players=data.value?.players??[],maxima=radarAxes.map(([key])=>Math.max(1,...players.map(p=>Number(p[key]))));return {tooltip:{...tip,formatter:(param:any)=>{const player=players.find(p=>p.player===param.data.player);return player?[player.name,...radarAxes.map(([key,name],i)=>`${name}: ${(Number(player[key])/(key==='travel'?1000:1)).toLocaleString(formatLocale)}${key==='travel'?t('m0763'):t('m0764')} · ${t('chart_relative_value',[param.value[i]])}`)].join('\n'):''}},legend:{type:'scroll',bottom:0},radar:{radius:'65%',indicator:radarAxes.map(([,name])=>({name,max:100})),splitArea:{areaStyle:{color:['#f6faf8','#eef5f2']}}},series:[{type:'radar',areaStyle:{opacity:.1},data:players.filter(p=>chosen.value.includes(p.player)).slice(0,3).map(p=>({name:p.name,player:p.player,value:radarAxes.map(([key],i)=>Math.round(Number(p[key])/maxima[i]!*1000)/10)}))}]}})
const options=computed(()=>({river,clock,bubble,sunburst,box,timeline,radar}[props.tab as 'river']?.value))
const titles:Record<string,string>={river:t('m0743'),clock:t('m0744'),bubble:t('m0745'),sunburst:t('m0746'),box:t('m0747'),timeline:t('m0748'),radar:t('m0749')}
const explanations:Record<string,string>={river:t('m0750'),clock:t('m0751'),bubble:t('m0752'),sunburst:t('m0753'),box:t('m0754'),timeline:t('m0755'),radar:t('m0756')}
const empty=computed(()=>props.tab==='box'?!runtimeRows.value.length:props.tab==='clock'?!props.base.hours.length:props.tab==='sunburst'?!props.base.contributions.some(c=>c.operation==='PLACE'):props.tab==='timeline'?!data.value?.milestones.length:props.tab==='river'?!riverData.value.some(a=>a.raw.some(v=>v!=null)):!data.value?.players.length)
</script>
<template><div class="more-charts">
 <p class="chart-help">{{explanations[tab]}}</p><p v-if="busy" role="status">{{ t('m0757') }}</p><p v-if="error" role="alert">{{error}} <button @click="load">{{ t('m0337') }}</button></p>
 <template v-if="data">
  <label v-if="tab==='box'" class="chart-select">{{ t('m0758') }}<select v-model="runtimeMetric"><option v-for="(label,key) in runtimeLabels" :key="key" :value="key">{{label[0]}}</option></select></label>
  <fieldset v-if="tab==='radar'" class="player-picks"><legend>{{ t('m0759') }}</legend><label v-for="p in data.players" :key="p.player"><input v-model="chosen" type="checkbox" :value="p.player" :disabled="chosen.length>=3&&!chosen.includes(p.player)"/>{{p.name}}</label></fieldset>
  <p v-if="empty" class="no-extra-data">{{ t('m0760') }}<template v-if="tab==='box'&&runtimeMetric==='host_cpu'">{{ t('m0761') }}</template></p>
  <p v-if="tab==='clock'&&!empty" class="chart-help clock-ring-key">{{t('chart_clock_order')}}</p>
  <DataChart v-if="!empty" :key="tab" :option="options??{}" :label="titles[tab]??t('m0762')" :height="460"/>
  <details v-if="tab==='river'&&!empty" class="raw-table activity-values"><summary>{{t('chart_raw_values')}}</summary><table><thead><tr><th>{{t('chart_day')}}</th><th v-for="a in riverData" :key="a.name">{{a.name}} ({{a.unit}})</th></tr></thead><tbody><tr v-for="(day,i) in days" :key="day"><th>{{day}}</th><td v-for="a in riverData" :key="a.name">{{a.raw[i]==null?t('chart_no_record'):a.raw[i]!.toLocaleString(formatLocale)}}</td></tr></tbody></table></details>
  <div v-if="tab==='radar'" class="raw-table"><table><thead><tr><th>{{ t('m0089') }}</th><th v-for="[,name] in radarAxes" :key="name">{{name}}</th></tr></thead><tbody><tr v-for="p in data.players.filter(p=>chosen.includes(p.player))" :key="p.player"><th>{{p.name}}</th><td v-for="[key] in radarAxes" :key="key">{{(Number(p[key])/(key==='travel'?1000:1)).toLocaleString(formatLocale)}}{{key==='travel'?t('m0763'):t('m0764')}}</td></tr></tbody></table></div>
  <ol v-if="tab==='timeline'" class="milestones"><li v-for="(e,i) in data.milestones.slice(0,30)" :key="i"><time>{{eventTime(e.at)}}</time><span>{{eventLabels[e.kind]}} · {{e.name}}<template v-if="e.revision">{{ t('m0765', [e.revision]) }}</template></span></li></ol>
  <details class="chart-help"><summary>{{ t('m0766', [eventTime(data.generatedAt)]) }}</summary><p v-for="note in data.notices" :key="note">{{systemMessage(note)}}</p></details>
 </template>
</div></template>
<style scoped>
.chart-help{font-size:12px;line-height:1.9;color:#607a6e;margin:14px 0}.chart-select{display:grid;gap:8px;max-width:260px;font-size:13px}.chart-select select{padding:10px;border:1px solid #cde0d4;border-radius:10px;background:#fff}.player-picks{display:flex;flex-wrap:wrap;gap:12px;border:1px solid #d9e7de;border-radius:12px;padding:12px;max-height:170px;overflow:auto}.player-picks label{display:flex;align-items:center;gap:6px;font-size:12px}.player-picks input{width:auto}.no-extra-data{padding:60px 16px;text-align:center;color:#6c8278}.raw-table{overflow:auto;max-width:100%;font-size:12px}.raw-table table{width:100%;border-collapse:collapse}.raw-table td,.raw-table th{padding:10px;border-bottom:1px solid #e5eee8;white-space:nowrap;text-align:left}.milestones{padding:0;list-style:none;max-height:300px;overflow:auto}.milestones li{display:flex;gap:15px;padding:12px;border-bottom:1px solid #e5eee8;font-size:12px}.milestones time{color:#698273;flex-shrink:0}@media(max-width:600px){.milestones li{flex-direction:column;gap:5px}}
</style>
