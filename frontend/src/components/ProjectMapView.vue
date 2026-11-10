<script setup lang="ts">
import { t } from '../i18n'

import {ref,onMounted,onBeforeUnmount,watch} from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
const props=defineProps<{url:string;minX:number;maxX:number;minZ:number;maxZ:number}>()
const host=ref<HTMLDivElement>(),error=ref(''),position=ref('')
let map:L.Map|undefined,overlay:L.ImageOverlay|undefined,pending:L.ImageOverlay|undefined,observer:ResizeObserver|undefined,alive=true,overview=true,fitting=false
const bounds=()=>L.latLngBounds([-(props.maxZ+1),props.minX],[-props.minZ,props.maxX+1])
function fit(){if(!map)return;overview=true;fitting=true;try{map.fitBounds(bounds(),{padding:[24,24],animate:false});map.setMinZoom(Math.min(-10,map.getZoom()-2))}finally{fitting=false}}
function refresh(){
  if(!map)return
  pending?.remove();const next=L.imageOverlay(props.url,bounds(),{opacity:0,alt:t('m0934')});pending=next
  next.once('load',()=>{if(!alive||pending!==next)return;overlay?.remove();overlay=next;pending=undefined;next.setOpacity(1);error.value=''})
  next.once('error',()=>{if(!alive||pending!==next)return;next.remove();pending=undefined;error.value=t('m0935')})
  next.addTo(map)
}
onMounted(()=>{
  map=L.map(host.value!,{crs:L.CRS.Simple,minZoom:-16,maxZoom:8,zoomSnap:.25,zoomDelta:.5,zoomControl:false,attributionControl:false})
  L.control.zoom({position:'bottomright',zoomInTitle:t('m0936'),zoomOutTitle:t('m0937')}).addTo(map)
  map.on('dragstart',()=>{overview=false})
  map.on('zoomstart',()=>{if(!fitting)overview=false})
  map.on('mousedown',()=>{overview=false})
  host.value!.addEventListener('wheel',()=>{overview=false},{passive:true})
  host.value!.addEventListener('touchstart',()=>{overview=false},{passive:true})
  fit();refresh()
  observer=new ResizeObserver(()=>{map?.invalidateSize({pan:false});if(overview)fit()});observer.observe(host.value!)
  map.on('mousemove',(e:L.LeafletMouseEvent)=>{position.value=`X ${Math.floor(e.latlng.lng)} · Z ${Math.floor(-e.latlng.lat)}`})
})
watch(()=>props.url,refresh)
onBeforeUnmount(()=>{alive=false;observer?.disconnect();map?.remove()})
</script>
<template>
  <div class="project-map-view">
    <div class="project-map-tools"><span>{{position || t('m0938')}}</span><button @click="fit">{{ t('m0939') }}</button></div>
    <div ref="host" class="project-map" :aria-label="t('m0940')" />
    <p v-if="error" role="alert" class="project-error">{{error}} <button @click="refresh">{{ t('m0337') }}</button></p>
  </div>
</template>
<style scoped>
.project-map-view{position:relative}.project-map{isolation:isolate;touch-action:none;overflow:hidden}.project-map :deep(.leaflet-image-layer){image-rendering:pixelated;max-width:none!important}.project-map-tools{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;color:#527364;font-size:12px}.project-map :deep(.leaflet-control-zoom a){color:#174e3d;background:white}
</style>
