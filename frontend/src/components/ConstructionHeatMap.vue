<script setup lang="ts">
import { formatLocale, t } from '../i18n'

import {ref,onMounted,onBeforeUnmount,watch,computed} from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {api} from '../api'
import type {Hotspot} from '../exploration'
const props=defineProps<{server:string;dimension:string;rows:Hotspot[]}>()
const host=ref<HTMLDivElement>(),notice=ref(''),surface=ref('64'),overview=ref(false)
const cells=computed(()=>{const sums=new Map<string,{x:number;z:number;value:number}>();for(const row of props.rows){const k=row.x+':'+row.z;const cell=sums.get(k)??{x:Number(row.x),z:Number(row.z),value:0};cell.value+=Number(row.value);sums.set(k,cell)}return [...sums.values()].sort((a,b)=>b.value-a.value)})
let allBounds:L.LatLngBounds|undefined
function locate(cell:{x:number;z:number}){map?.setView([-(cell.z+16),cell.x+16],2,{animate:false})}
function fitAll(){if(allBounds?.isValid())map?.fitBounds(allBounds,{padding:[24,24],maxZoom:2,animate:false})}
let map:L.Map|undefined,tiles:L.TileLayer|undefined,layer:L.LayerGroup|undefined,observer:ResizeObserver|undefined,base='',alive=true
function draw(){
 if(!map)return;layer?.remove();layer=L.layerGroup().addTo(map);tiles?.remove();
 const dimension=props.dimension==='minecraft:nether'?'Nether_'+surface.value:props.dimension==='minecraft:the_end'?'End':'Overworld'
 if(base)tiles=L.tileLayer(base+`api/tiles/${dimension}/{z}/{x}/{y}`,{minZoom:0,maxZoom:4,noWrap:true,keepBuffer:1,updateWhenIdle:true}).addTo(map)
 const max=Math.max(1,...cells.value.map(c=>c.value)),bounds=L.latLngBounds([])
 for(const c of cells.value){const box=L.latLngBounds([-(c.z+32),c.x],[-c.z,c.x+32]);bounds.extend(box);const color=`hsl(${48-48*Math.log1p(c.value)/Math.log1p(max)} 90% 48%)`;const tooltip=document.createElement('span');tooltip.textContent=t('m0666', [c.x, c.x+31, c.z, c.z+31, c.value.toLocaleString(formatLocale)]);
  L.rectangle(box,{color,weight:1,fillColor:color,fillOpacity:.45}).bindTooltip(tooltip,{sticky:true}).on('click',()=>{if(map!.getZoom()<0)locate(c);}).addTo(layer)}
 allBounds=bounds;
 if(bounds.isValid()){if(map.getBoundsZoom(bounds,false,L.point(48,48))<0)locate(cells.value[0]!);else fitAll()}else map.setView([0,0],0)
}
onMounted(async()=>{
 map=L.map(host.value!,{crs:L.CRS.Simple,minZoom:-10,maxZoom:4,attributionControl:false,preferCanvas:true});map.on('zoomend',()=>{overview.value=map!.getZoom()<0});map.setView([0,0],0)
 observer=new ResizeObserver(()=>map?.invalidateSize({pan:false}));observer.observe(host.value!);draw()
 try{const maps=await api<{serverId:string;viewerUrl:string|null}[]>('/world-maps');if(!alive)return;const url=maps.find(m=>m.serverId===props.server)?.viewerUrl;if(url){const parsed=new URL(url,location.origin);if(parsed.origin===location.origin)base=parsed.pathname.replace(/\/?$/,'/');else notice.value=t('m0667')}else notice.value=t('m0668');draw()}catch{notice.value=t('m0669')}
})
watch(()=>[props.rows,props.dimension,surface.value],draw)
onBeforeUnmount(()=>{alive=false;observer?.disconnect();map?.remove()})
</script>
<template><div><label v-if="dimension==='minecraft:nether'">{{ t('m0670') }}<select v-model="surface"><option v-for="y in [16,32,48,64,80,96,112]" :key="y" :value="String(y)">{{y}}</option></select></label><div class="map-locations"><button @click="fitAll" :disabled="!cells.length">{{ t('m0671') }}</button><button v-for="(cell,i) in cells.slice(0,3)" :key="cell.x+':'+cell.z" @click="locate(cell)">{{ t('m0672', [i+1, cell.value.toLocaleString(formatLocale)]) }}</button></div><div ref="host" class="construction-heatmap" :aria-label="t('m0673')"/><p v-if="overview" class="muted">{{ t('m0674') }}</p><p class="muted">{{ t('m0675', [notice]) }}</p></div></template>
<style scoped>.map-locations{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.map-locations button{padding:8px 12px;border:1px solid #cee0d5;border-radius:8px;background:#f1f8f4;color:#235b47;font-size:12px}.construction-heatmap{height:460px;border-radius:16px;background:#e6ede6;isolation:isolate}.construction-heatmap :deep(img.leaflet-tile){image-rendering:pixelated;max-width:none!important}.muted{font-size:12px;line-height:1.8;color:#59746a}</style>
