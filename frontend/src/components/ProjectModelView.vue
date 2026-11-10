<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { api, ApiError } from '../api'
import { gameName } from '../gameNames'
import {readHeight,saveHeight,type HeightPreference} from '../projectViewPreferences'
import {projectHeightClipping} from '../projectHeightClipping'
import { createProjectScene, type ProjectScene, type SceneObject } from '../projectScene'
const props=defineProps<{id:string;revision:number}>()
interface SceneStatus {state:string;message:string;build:string|null;version:number;latestVersion:number;observedAt:string|null;issues:string[]}
const host=ref<HTMLDivElement>(),error=ref(''),busy=ref(false),showMoving=ref(false),status=ref<SceneStatus>(),ready=ref(false),triangles=ref(0),issues=ref<string[]>([]),observedAt=ref<string|null>(null),minY=ref(-64),maxY=ref(319)
let alive=true,timer:ReturnType<typeof setInterval>|undefined,animationTimer:ReturnType<typeof setInterval>|undefined,controller=new AbortController(),displayed:string|null=null
let renderer:THREE.WebGLRenderer|undefined,scene:THREE.Scene,camera:THREE.PerspectiveCamera,controls:OrbitControls,observer:ResizeObserver,object:SceneObject|undefined,radius=10,span=20,manualHeight=false
interface HeightRange {minY:number;maxY:number;suggestedMinY:number;basis:'PLAYER_PLACEMENT'|'SURFACE_ESTIMATE'}
const fullRange=ref<HeightRange>(),heightNotice=ref('')
const loadingStage=ref('正在检查场景状态…')
let rangeBuild='',displayedRange='',displayRange:HeightPreference|undefined,requestEpoch=0,loadController:AbortController|undefined,fitAfterLoad=false
const expanded=ref(false)
const modelRoot=ref<HTMLDivElement>(),exitButton=ref<HTMLButtonElement>()
type FullscreenDocument=Document&{webkitFullscreenElement?:Element;webkitExitFullscreen?:()=>Promise<void>|void}
type FullscreenElement=HTMLDivElement&{webkitRequestFullscreen?:()=>Promise<void>|void}
let nativeFullscreen=false,returnFocus:HTMLElement|null=null,scrollStyles:{html:string;body:string}|undefined
const inertElements=new Map<HTMLElement,boolean>()
const fullscreenElement=()=>document.fullscreenElement||(document as FullscreenDocument).webkitFullscreenElement
function restorePage(){
  if(scrollStyles){document.documentElement.style.overflow=scrollStyles.html;document.body.style.overflow=scrollStyles.body;scrollStyles=undefined}
  for(const [element,previous] of inertElements)element.inert=previous
  inertElements.clear()
}
function finishFullscreen(){
  stopMove();nativeFullscreen=false;expanded.value=false;restorePage()
  void nextTick(()=>{if(alive){resize();if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true})}})
}
async function exitFullscreen(){
  if(fullscreenElement()===modelRoot.value){
    try{if(document.exitFullscreen)await document.exitFullscreen();else await (document as FullscreenDocument).webkitExitFullscreen?.()}catch{/* The browser may already have exited. */}
  }
  finishFullscreen()
}
function fullscreenChanged(){
  if(fullscreenElement()===modelRoot.value)nativeFullscreen=true
  else if(nativeFullscreen)finishFullscreen()
}
async function enterFullscreen(){
  if(expanded.value)return
  stopMove();returnFocus=document.activeElement instanceof HTMLElement?document.activeElement:null
  scrollStyles={html:document.documentElement.style.overflow,body:document.body.style.overflow}
  document.documentElement.style.overflow='hidden';document.body.style.overflow='hidden';expanded.value=true
  // Move out of transformed/clipped page ancestors before requesting native fullscreen.
  await nextTick();if(!alive||!expanded.value)return
  const element=modelRoot.value as FullscreenElement
  for(const sibling of document.body.children)if(sibling instanceof HTMLElement&&sibling!==element&&!sibling.contains(element)){inertElements.set(sibling,sibling.inert);sibling.inert=true}
  try{if(element.requestFullscreen)await element.requestFullscreen({navigationUI:'hide'});else await element.webkitRequestFullscreen?.()}catch{/* Keep an edge-to-edge page view when the browser cannot fullscreen an element. */}
  if(alive&&expanded.value){nativeFullscreen=fullscreenElement()===element;resize();exitButton.value?.focus({preventScroll:true})}
}
const directions=[{id:'forward',label:'前进',icon:'↑'},{id:'back',label:'后退',icon:'↓'},{id:'left',label:'左移',icon:'←'},{id:'right',label:'右移',icon:'→'},{id:'up',label:'上升',icon:'＋'},{id:'down',label:'下降',icon:'−'}] as const
const rotations=[{id:'rotateLeft',label:'向左旋转',icon:'↶'},{id:'rotateRight',label:'向右旋转',icon:'↷'},{id:'rotateUp',label:'向上环绕',icon:'⤴'},{id:'rotateDown',label:'向下环绕',icon:'⤵'}] as const
type MoveDirection=typeof directions[number]['id']|typeof rotations[number]['id']
const moving=ref<MoveDirection|null>(null)
let moveFrame=0,movePointer:number|null=null,moveButton:HTMLElement|null=null
function visibleBounds(){
  const bounds=object?.bounds.clone()??new THREE.Box3(new THREE.Vector3(-1,-1,-1),new THREE.Vector3(1,1,1))
  if(displayRange){bounds.min.y=Math.max(bounds.min.y,displayRange.minY);bounds.max.y=Math.min(bounds.max.y,displayRange.maxY+1)}
  return bounds
}
function centerOrbit(){
  if(!renderer||!object)return
  const bounds=visibleBounds();if(bounds.isEmpty())return
  const target=bounds.getCenter(new THREE.Vector3()).sub(object.center)
  // Explicit recenter only: ordinary orbit gestures retain the current viewing focus.
  camera.position.add(target.clone().sub(controls.target));controls.target.copy(target);controls.update();render()
}
function moveView(direction:MoveDirection,seconds:number){
  if(!ready.value||!renderer)return
  if(direction.startsWith('rotate')){
    const angle=seconds*Math.PI/3
    if(direction==='rotateLeft'||direction==='rotateRight')controls.rotateLeft(direction==='rotateLeft'?angle:-angle)
    else controls.rotateUp(direction==='rotateUp'?angle:-angle)
    controls.update();render();return
  }
  // Translate camera and orbit target together: movement never changes viewing angle or zoom.
  camera.updateMatrixWorld()
  const right=new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld,0);right.y=0;right.normalize()
  const forward=new THREE.Vector3().crossVectors(THREE.Object3D.DEFAULT_UP,right).normalize()
  const delta=direction==='up'||direction==='down'?new THREE.Vector3(0,direction==='up'?1:-1,0):direction==='left'||direction==='right'?right.multiplyScalar(direction==='left'?-1:1):forward.multiplyScalar(direction==='forward'?1:-1)
  const speed=Math.max(.5,Math.min(80,camera.position.distanceTo(controls.target)*.35))
  delta.multiplyScalar(speed*seconds);camera.position.add(delta);controls.target.add(delta);controls.update();render()
}
function stopMove(){
  cancelAnimationFrame(moveFrame);moving.value=null;const button=moveButton,pointer=movePointer;moveButton=null;movePointer=null
  if(pointer!==null&&button?.hasPointerCapture(pointer))button.releasePointerCapture(pointer)
}
function startMove(event:PointerEvent,direction:MoveDirection){
  if(!ready.value||event.button!==0)return
  stopMove();moveButton=event.currentTarget as HTMLElement;movePointer=event.pointerId;moveButton.setPointerCapture(event.pointerId);moving.value=direction
  moveView(direction,.12);let last=performance.now(),start=last
  function tick(now:number){if(moving.value!==direction)return;if(now-start>=250)moveView(direction,Math.min(.05,(now-last)/1000));last=now;moveFrame=requestAnimationFrame(tick)}
  moveFrame=requestAnimationFrame(tick)
}
function clickMove(event:MouseEvent,direction:MoveDirection){if(event.detail===0)moveView(direction,.12)}
function visibilityChanged(){if(document.hidden)stopMove()}
let chosenRange:HeightPreference|undefined
const savedHeight=readHeight(props.id)
if(savedHeight){chosenRange={...savedHeight};manualHeight=true;minY.value=savedHeight.minY;maxY.value=savedHeight.maxY}
function saveRange(){saveHeight(props.id,{minY:minY.value,maxY:maxY.value})}
function showAll(){fitAfterLoad=true;allHeights()}
function escapeView(e:KeyboardEvent){
  if(!expanded.value)return
  if(e.key==='Escape')void exitFullscreen()
  if(e.key==='Tab'){
    const buttons=Array.from(modelRoot.value?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),[tabindex="0"]')??[]).filter(element=>element.getClientRects().length)
    const first=buttons[0],last=buttons.at(-1)
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}
  }
}
const path=()=>`/public/projects/${props.id}/phases/${props.revision}/scene`
interface HistoryFrame {id:string;version:number;savedAt:string;observedAt:string|null;sections:number}
interface BlockInfo {x:number;y:number;z:number;known:boolean;block:{name:string;states:string}|null;extra:{name:string;states:string}|null;observedAt:string|null;events:{occurredAt:string;player:string;operation:string;block:string}[];more:boolean;notice:string}
const frames=ref<HistoryFrame[]>([]),historyMore=ref(false),historyError=ref(''),historyBusy=ref(false),selectedHistory=ref(''),playing=ref(false),selectedBlock=ref<BlockInfo>(),blockBusy=ref(false),blockError=ref('')
const orderedFrames=computed(()=>[...frames.value].reverse()),frameIndex=computed(()=>orderedFrames.value.findIndex(f=>f.id===selectedHistory.value))
let historyTimer:ReturnType<typeof setInterval>|undefined,playTimer:ReturnType<typeof setInterval>|undefined,displayedHistory='',pickSequence=0
let pointerStart:{id:number;x:number;y:number;time:number}|null=null,selectionBox:THREE.Box3Helper|undefined
const dateLabel=(time:string|null)=>time?new Date(time).toLocaleString():'时间未知'
const blockLabel=(name:string)=>gameName(name,'block')??name
async function readHistory(older=false){
  if(historyBusy.value)return;historyBusy.value=true
  try{const before=older?frames.value.at(-1)?.savedAt:undefined;const result=await api<{frames:HistoryFrame[];more:boolean}>(path()+'/history'+(before?'?before='+encodeURIComponent(before):''),{signal:controller.signal});if(!alive)return
    const merged=new Map((older?frames.value:[]).map(f=>[f.id,f]));for(const f of result.frames)merged.set(f.id,f)
    // Keep already loaded older frames while polling the newest page.
    if(!older)for(const f of frames.value)if(!merged.has(f.id))merged.set(f.id,f)
    frames.value=[...merged.values()].sort((a,b)=>b.savedAt.localeCompare(a.savedAt));if(older||frames.value.length<=100)historyMore.value=result.more;historyError.value=''
  }catch(e){if(alive)historyError.value=e instanceof Error?e.message:'历史画面读取失败'}finally{historyBusy.value=false}
}
function clearSelection(){pickSequence++;selectedBlock.value=undefined;blockError.value='';blockBusy.value=false;if(selectionBox){scene.remove(selectionBox);selectionBox.geometry.dispose();(selectionBox.material as THREE.Material).dispose();selectionBox=undefined}render()}
watch(selectedHistory,()=>{requestEpoch++;loadController?.abort();clearSelection();ready.value=false;void load()})
function selectFrame(event:Event){playing.value=false;selectedHistory.value=orderedFrames.value[Number((event.target as HTMLInputElement).value)]?.id??''}
function playHistory(){if(playing.value){playing.value=false;return}if(!frames.value.length)return;playing.value=true;if(!selectedHistory.value||frameIndex.value===orderedFrames.value.length-1)selectedHistory.value=orderedFrames.value[0]!.id}
function pointerDown(event:PointerEvent){if(!event.isPrimary||event.button!==0){pointerStart=null;return}pointerStart={id:event.pointerId,x:event.clientX,y:event.clientY,time:performance.now()}}
function pointerMoved(event:PointerEvent){if(pointerStart&&Math.hypot(event.clientX-pointerStart.x,event.clientY-pointerStart.y)>6)pointerStart=null}
async function pointerUp(event:PointerEvent){
  const start=pointerStart;pointerStart=null;if(!start||start.id!==event.pointerId||performance.now()-start.time>700||!object||!renderer||!displayed||busy.value||!ready.value||displayedHistory!==selectedHistory.value)return
  if(expanded.value&&matchMedia('(max-width:700px),(hover:none) and (pointer:coarse)').matches)return
  const rect=renderer.domElement.getBoundingClientRect(),ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,1-(event.clientY-rect.top)/rect.height*2),camera)
  const hit=object.pick(ray,displayRange?.minY??-Infinity,displayRange?.maxY??Infinity);clearSelection();if(!hit)return
  const x=Math.floor(hit.x),y=Math.floor(hit.y),z=Math.floor(hit.z),build=displayed,sequence=pickSequence
  const box=new THREE.Box3(new THREE.Vector3(x,y,z).sub(object.center),new THREE.Vector3(x+1,y+1,z+1).sub(object.center));selectionBox=new THREE.Box3Helper(box,0xf3b52b);scene.add(selectionBox);render();blockBusy.value=true
  try{const result=await api<BlockInfo>(path()+`/${build}/block?x=${x}&y=${y}&z=${z}`,{signal:controller.signal});if(alive&&sequence===pickSequence&&build===displayed)selectedBlock.value=result}
  catch(e){if(alive&&sequence===pickSequence)blockError.value=e instanceof Error?e.message:'方块记录读取失败'}finally{if(sequence===pickSequence)blockBusy.value=false}
}
function render(){if(alive&&renderer)renderer.render(scene,camera)}
function resize(){if(!renderer||!host.value)return;const w=host.value.clientWidth,h=host.value.clientHeight;renderer.setSize(w,h,false);camera.aspect=w/Math.max(h,1);camera.updateProjectionMatrix();render()}
function fit(){
  stopMove()
  if(!renderer)return
  const target=new THREE.Vector3();let viewRadius=radius
  if(object&&displayRange){
    const visible=object.bounds.clone();visible.min.y=Math.max(visible.min.y,displayRange.minY);visible.max.y=Math.min(visible.max.y,displayRange.maxY+1)
    if(!visible.isEmpty()){visible.getCenter(target).sub(object.center);viewRadius=Math.max(3,visible.getSize(new THREE.Vector3()).length()/2)}
  }
  const half=Math.min(camera.fov*Math.PI/360,Math.atan(Math.tan(camera.fov*Math.PI/360)*camera.aspect))
  camera.position.set(.85,.7,.85).normalize().multiplyScalar(viewRadius/Math.sin(half)*1.15).add(target)
  camera.near=.05;camera.far=Math.max(1000,span*12);camera.updateProjectionMatrix();controls.target.copy(target);controls.maxDistance=span*8;controls.update();render()
}
function heights(){if(!renderer||!object)return;renderer.clippingPlanes=displayRange?projectHeightClipping(object.center.y,displayRange.minY,displayRange.maxY):[];render()}
function reloadRange(){requestEpoch++;loadController?.abort();stopMove();clearSelection();void load()}
function applyHeight(){if(!Number.isInteger(minY.value)||!Number.isInteger(maxY.value)||minY.value>maxY.value||minY.value < -2048||maxY.value>4095){error.value='请填写有效的最低和最高显示高度。';return}error.value='';manualHeight=true;chosenRange={minY:minY.value,maxY:maxY.value};saveRange();heightNotice.value='使用你保存的高度范围，下方未选中的模型不加载。';reloadRange()}
function allHeights(){if(!fullRange.value)return;minY.value=fullRange.value.minY;maxY.value=fullRange.value.maxY;applyHeight()}
function constructionHeight(){manualHeight=false;chosenRange=undefined;saveHeight(props.id,null);fitAfterLoad=true;reloadRange()}
function toggleMoving(){object?.setMovingEntities(showMoving.value);render()}
function clear(){stopMove();if(object){scene.remove(object.group);object.dispose();object=undefined}ready.value=false;displayed=null;render()}
function issueText(value:string){return value.replace(/^missing texture: /,'缺少贴图：').replace(/^unreadable texture: /,'贴图无法读取：').replace(/^missing block model: /,'缺少方块模型：').replace(/^missing entity(?: model)?: /,'缺少生物或实体模型：').replace(/^missing wearable(?: geometry)?: /,'缺少装备模型：').replace(/^empty geometry: /,'模型未生成几何体：')}
async function load(){
  if(busy.value||!alive)return;busy.value=true
  const requested=selectedHistory.value,epoch=requestEpoch;loadController=new AbortController();const signal=loadController.signal
  const current=()=>alive&&epoch===requestEpoch&&requested===selectedHistory.value
  try{
    loadingStage.value='正在检查场景状态…'
    const latest=await api<SceneStatus>(path()+(requested?`/history/${requested}`:'')+'/status',{signal});if(!current())return;status.value=latest
    if(latest.state!=='READY'||!latest.build)return
    const build=latest.build
    if(rangeBuild!==build){const range=await api<HeightRange>(path()+`/${build}/height-range`,{signal});if(!current())return;fullRange.value=range;rangeBuild=build}
    if(!manualHeight&&fullRange.value){minY.value=fullRange.value.suggestedMinY;maxY.value=fullRange.value.maxY; heightNotice.value=fullRange.value.basis==='PLAYER_PLACEMENT'?'默认从工程内玩家放置方块的最低高度开始。':'暂无可用放置记录，暂按已采集地表估算起点；可手动调整。'}
    else heightNotice.value='使用你保存的高度范围，下方未选中的模型不加载。'
    const range=manualHeight&&chosenRange?{...chosenRange}:{minY:minY.value,maxY:maxY.value},rangeKey=`${range.minY}:${range.maxY}`
    if(latest.build===displayed&&rangeKey===displayedRange){ready.value=!!object?.triangles;if(fitAfterLoad){fitAfterLoad=false;fit()}return}
    loadingStage.value='正在读取所选高度的模型…'
    const data=await api<ProjectScene>(path()+`/${build}/scene.json?minY=${range.minY}&maxY=${range.maxY}`,{signal})
    loadingStage.value='正在准备模型几何…'
    const next=await createProjectScene(data,file=>'/api'+path()+`/${build}/${file}`,signal,range,(done,total)=>{if(current())loadingStage.value=done===total?'正在显示模型…':`正在读取贴图 ${done} / ${total}…`})
    if(!current()){next.dispose();return}
    clearSelection();displayedHistory=requested
    const previous=object,initial=!previous;object=next;next.setMovingEntities(showMoving.value);scene.add(next.group)
    if(previous){const offset=previous.center.clone().sub(next.center);camera.position.add(offset);controls.target.add(offset);scene.remove(previous.group);previous.dispose()}
    displayed=build;displayedRange=rangeKey;displayRange=range;triangles.value=next.triangles;issues.value=next.issues;observedAt.value=latest.observedAt;ready.value=next.triangles>0;error.value=ready.value?'':'这个高度范围内没有已采集的模型，请调整范围。'
    const size=next.bounds.getSize(new THREE.Vector3());span=Math.max(12,size.x,size.y,size.z);radius=Math.max(3,size.length()/2);heights()
    if(initial||fitAfterLoad){fitAfterLoad=false;fit()}else{camera.far=Math.max(1000,span*12);camera.updateProjectionMatrix();controls.maxDistance=span*8;controls.update();render()}
  }catch(e){if(!current()||signal.aborted)return;error.value=e instanceof Error?e.message:'场景读取失败';playing.value=false;if(e instanceof ApiError&&e.status===404){clear();if(!requested)clearInterval(timer)}}
  finally{busy.value=false;if(alive&&!current())void load()}
}
onMounted(()=>{
  window.addEventListener('blur',stopMove);document.addEventListener('visibilitychange',visibilityChanged)
  window.addEventListener('keydown',escapeView)
  document.addEventListener('fullscreenchange',fullscreenChanged);document.addEventListener('webkitfullscreenchange',fullscreenChanged)
  try{
    scene=new THREE.Scene();scene.background=new THREE.Color('#eef5f1');camera=new THREE.PerspectiveCamera(42,1,.05,1000)
    renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.domElement.setAttribute('aria-label','可旋转的建筑场景');renderer.domElement.setAttribute('role','img');host.value!.appendChild(renderer.domElement)
    controls=new OrbitControls(camera,renderer.domElement);controls.addEventListener('change',render)
    renderer.domElement.addEventListener('pointerdown',pointerDown);renderer.domElement.addEventListener('pointermove',pointerMoved);renderer.domElement.addEventListener('pointerup',pointerUp);renderer.domElement.addEventListener('pointercancel',()=>{pointerStart=null})
    scene.add(new THREE.HemisphereLight(0xffffff,0x778878,2));const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(30,60,20);scene.add(light)
    observer=new ResizeObserver(resize);observer.observe(host.value!);fit();resize()
    renderer.domElement.addEventListener('webglcontextlost',e=>{e.preventDefault();stopMove();ready.value=false;error.value='浏览器暂时无法显示三维图形，请重新打开预览。';controller.abort();loadController?.abort();clearInterval(timer);clearInterval(animationTimer)})
    animationTimer=setInterval(()=>{if(!document.hidden&&object?.update(performance.now()))render()},50)
    void load();timer=setInterval(()=>{if(!document.hidden)void load()},5000)
    void readHistory();historyTimer=setInterval(()=>{if(!document.hidden)void readHistory()},60000)
    playTimer=setInterval(()=>{if(!playing.value||busy.value||document.hidden||!ready.value||displayedHistory!==selectedHistory.value)return;const next=orderedFrames.value[frameIndex.value+1];if(next)selectedHistory.value=next.id;else playing.value=false},3000)
  }catch{error.value='这台设备暂不支持三维预览，可以继续使用二维地图。'}
})
onBeforeUnmount(()=>{alive=false;clearInterval(historyTimer);clearInterval(playTimer);clearSelection();void exitFullscreen();document.removeEventListener('fullscreenchange',fullscreenChanged);document.removeEventListener('webkitfullscreenchange',fullscreenChanged);restorePage();stopMove();window.removeEventListener('blur',stopMove);document.removeEventListener('visibilitychange',visibilityChanged);window.removeEventListener('keydown',escapeView);controller.abort();loadController?.abort();clearInterval(timer);clearInterval(animationTimer);observer?.disconnect();controls?.dispose();clear();renderer?.dispose();renderer?.forceContextLoss()})
</script>
<template>
  <Teleport to="body" :disabled="!expanded">
  <div ref="modelRoot" class="project-model" :class="{'model-expanded':expanded}" :role="expanded?'dialog':undefined" :aria-modal="expanded?true:undefined" :aria-label="expanded?'三维建筑全屏预览':undefined">
    <button v-if="expanded" ref="exitButton" type="button" class="model-exit-fullscreen" @click="exitFullscreen">退出全屏</button>
    <div class="model-toolbars">
    <section class="model-history" aria-label="建筑施工时光机">
      <div class="history-heading"><strong>建筑施工时光机</strong><span>{{ selectedHistory ? '正在查看历史画面' : '跟随最新采集' }}</span></div>
      <div class="history-actions"><select v-model="selectedHistory" aria-label="选择历史画面" @change="playing=false"><option value="">最新画面</option><option v-for="frame in frames" :key="frame.id" :value="frame.id">{{ dateLabel(frame.savedAt) }}</option></select><button :disabled="frames.length<2" @click="playHistory">{{ playing?'暂停回放':'播放建设过程' }}</button><button v-if="selectedHistory" @click="playing=false;selectedHistory=''">回到最新</button><button v-if="historyMore" :disabled="historyBusy" @click="readHistory(true)">更早的画面</button></div>
      <input v-if="frames.length>1" class="history-range" type="range" aria-label="施工时间轴" min="0" :max="frames.length-1" :value="frameIndex<0?frames.length-1:frameIndex" @input="selectFrame" />
      <p>约每 5 分钟保存有变化的场景。各处分批采集，并非同一瞬间；启用前的过程无法补回。{{ frames.length===1?'已有一个历史画面，积累两次后即可播放。':frames.length?'':'还没有历史画面，收到模型后会自动开始保存。' }}</p><p v-if="historyError" role="alert">{{ historyError }}</p>
    </section>
    <div class="model-controls"><label class="model-entity-toggle"><input v-model="showMoving" type="checkbox" @change="toggleMoving" />显示动物和怪物</label><label>最低显示高度 Y <input v-model.number="minY" type="number" min="-2048" max="4095" /></label><label>最高显示高度 Y <input v-model.number="maxY" type="number" min="-2048" max="4095" /></label><button :disabled="busy||!fullRange" @click="applyHeight">查看这一层</button><button :disabled="busy||!fullRange" @click="allHeights">全部高度</button><button :disabled="busy||!fullRange" @click="constructionHeight">施工起点</button><button @click="fit">回到全景</button><button :disabled="busy" @click="showAll">显示全部模型</button><button v-show="!expanded" @click="enterFullscreen">全屏查看</button><button :disabled="busy" @click="load">刷新状态</button></div>
    <div class="model-navigation" role="group" aria-label="移动三维视角">
      <span class="model-navigation-title">移动视角<small>点按微调 · 长按连续移动</small></span>
      <div class="model-move-buttons"><button v-for="direction in directions" :key="direction.id" type="button" :disabled="!ready" :class="{'is-moving':moving===direction.id}" :aria-label="direction.label+'视角'" @pointerdown.prevent="startMove($event,direction.id)" @pointerup="stopMove" @pointercancel="stopMove" @lostpointercapture="stopMove" @contextmenu.prevent @click="clickMove($event,direction.id)"><span aria-hidden="true">{{ direction.icon }}</span>{{ direction.label }}</button></div>
    </div>
    <div class="model-navigation model-rotation" role="group" aria-label="旋转三维视角">
      <span class="model-navigation-title">围绕模型旋转<small>围绕当前观察中心，保留缩放</small></span>
      <div class="model-rotate-buttons"><button v-for="direction in rotations" :key="direction.id" type="button" :disabled="!ready" :class="{'is-moving':moving===direction.id}" :aria-label="direction.label" @pointerdown.prevent="startMove($event,direction.id)" @pointerup="stopMove" @pointercancel="stopMove" @lostpointercapture="stopMove" @contextmenu.prevent @click="clickMove($event,direction.id)"><span aria-hidden="true">{{ direction.icon }}</span>{{ direction.label }}</button><button type="button" :disabled="!ready" @click="centerOrbit">重新居中</button></div>
    </div>
    </div>
    <p v-if="error" role="alert" class="project-error model-error">{{ error }}</p>
    <p class="project-muted model-pick-hint">轻点模型中的方块，查看坐标、状态和已有施工记录。拖动仍用于旋转；手机请退出全屏后点选查询。</p>
    <div ref="host" class="model-canvas"><div v-if="!ready&&!error" class="model-placeholder">{{ busy ? loadingStage : status?.message ?? '正在连接场景服务…' }}</div><span v-if="ready&&(busy||status?.state==='BUILDING'||status?.state==='QUEUED')" class="model-updating">{{ busy ? loadingStage : status?.message }}</span></div>
    <section v-if="selectedBlock||blockBusy||blockError" class="model-block-info" aria-label="选中方块信息">
      <button class="block-close" aria-label="关闭方块信息" @click="clearSelection">×</button>
      <p v-if="blockBusy">正在查询这个方块…</p><p v-if="blockError" role="alert">{{ blockError }}</p>
      <template v-if="selectedBlock"><h3>{{ selectedBlock.block?blockLabel(selectedBlock.block.name):'此处尚无方块记录' }}</h3><p>X {{ selectedBlock.x }} · Y {{ selectedBlock.y }} · Z {{ selectedBlock.z }}</p><p>此处采集时间：{{ dateLabel(selectedBlock.observedAt) }}</p><p v-if="selectedBlock.extra&&selectedBlock.extra.name!=='minecraft:air'">同位置附加层：{{ blockLabel(selectedBlock.extra.name) }}</p><details v-if="selectedBlock.block?.states"><summary>方块状态与朝向</summary><pre>{{ selectedBlock.block.states }}</pre></details>
      <h4>这里的施工记录</h4><ul v-if="selectedBlock.events.length"><li v-for="(event,i) in selectedBlock.events" :key="i">{{ dateLabel(event.occurredAt) }} · {{ event.player }} {{ event.operation==='PLACE'?'放置':'拆除' }}了{{ blockLabel(event.block) }}</li></ul><p v-else>没有对应的施工记录，无法判断是谁放置的。</p><p v-if="selectedBlock.more">仅显示最近 50 条记录。</p><small>{{ selectedBlock.notice }}</small></template>
    </section>
    <p class="project-muted">{{ heightNotice }} 高度设置仅保存在当前浏览器，按工程分别记忆。调整到 −64 或点击“全部高度”时才加载下方内容。<br/>移动和旋转均可点按或长按；旋转保持你平移、缩放后的观察中心。“重新居中”保留缩放，“回到全景”显示整个模型。<br/>鼠标拖动旋转 · 滚轮缩放 · 右键平移；手机单指旋转、双指缩放和平移。<br/>{{ ready ? `已显示 ${triangles.toLocaleString()} 个模型面片` : status?.message }} · 当前画面采集时间：{{ observedAt ? new Date(observedAt).toLocaleString() : '尚未显示' }}</p>
    <p v-if="ready&&status?.state==='FAILED'" class="project-error">更新未完成，当前保留上一次成功显示的场景。</p>
    <details v-if="issues.length" class="project-error"><summary>有 {{ issues.length }} 项内容尚未完整显示</summary><ul><li v-for="(issue,index) in issues" :key="index">{{ issueText(issue) }}</li></ul></details>
    <details class="project-muted"><summary>场景如何记录</summary><p>包含工程范围内已采集的原有方块、新建内容、盔甲架及建筑装饰。动物和怪物也会记录，可用开关显示或隐藏；掉落物不记录。游戏分批扫描已加载区域，因此各处的采集时间可能不同；尚未加载的区域不代表空气。显示高度只影响查看，不会删除记录。</p><p>完成工程后保留最后收到的场景，继续工程会开始新的记录阶段。</p></details>
  </div>
  </Teleport>
</template>
<style scoped>
.model-history{padding:12px 14px;margin-bottom:14px;background:linear-gradient(110deg,#edf7f0,#f4f0ff);border:1px solid #d1e4d7;border-radius:12px}.history-heading,.history-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.history-heading{justify-content:space-between;margin-bottom:10px;color:#174e3d}.history-heading span,.model-history p{font-size:12px;color:#597462}.model-history p{margin:8px 0 0}.history-actions select{flex:1;min-width:160px;max-width:100%;padding:9px;border:1px solid #c3d7cb;border-radius:8px;background:white;color:#174e3d}.history-range{width:100%;accent-color:#16865e;margin-top:12px}.model-block-info{position:relative;padding:14px 40px 14px 14px;border:1px solid #e0c36f;background:#fffbea;border-radius:12px;margin-bottom:12px;color:#4a472c}.model-block-info h3,.model-block-info h4{margin:0 0 8px}.model-block-info p,.model-block-info li{font-size:13px;margin:6px 0}.model-block-info ul{max-height:180px;overflow:auto;padding-left:20px}.model-block-info small{font-size:12px;color:#736a4b}.model-block-info pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}.block-close{position:absolute;right:8px;top:8px;min-width:32px;min-height:32px}.model-expanded .model-block-info{position:absolute;z-index:3;top:70px;left:16px;max-width:420px;max-height:42%;overflow:auto}.model-expanded .model-history{margin-bottom:8px}.model-expanded .model-history p{display:none}@media(max-width:700px),(hover:none) and (pointer:coarse){.model-expanded .model-block-info{display:none}.history-actions button{font-size:12px;padding:8px}}
.model-expanded button{font:inherit;border:1px solid #c7d9cf;border-radius:10px;padding:10px 16px;background:#fff;color:#285d49;cursor:pointer}.model-expanded button:disabled{opacity:.5;cursor:default}.model-expanded button:focus-visible{outline:3px solid #56ad87;outline-offset:2px}
.model-navigation{display:flex;align-items:center;flex-wrap:wrap;gap:10px 16px;margin:0 0 12px;padding:10px;background:#f1f8f4;border:1px solid #d6e7dc;border-radius:12px}.model-navigation-title{font-size:14px;font-weight:600;color:#174e3d}.model-navigation-title small{display:block;font-size:12px;font-weight:400;color:#587566;margin-top:3px}.model-move-buttons{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:6px;flex:1;min-width:300px}:is(.model-move-buttons,.model-rotate-buttons) button{display:flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:8px 10px;touch-action:none;user-select:none;-webkit-touch-callout:none}:is(.model-move-buttons,.model-rotate-buttons) button span{font-size:18px}:is(.model-move-buttons,.model-rotate-buttons) button.is-moving{background:#138357;color:white;border-color:#138357}:is(.model-move-buttons,.model-rotate-buttons) button:focus-visible{outline:3px solid #56ad87;outline-offset:2px}@media(max-width:600px){.model-navigation{gap:8px}.model-navigation-title{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.model-navigation-title small{margin:0}.model-move-buttons{min-width:0;width:100%;flex-basis:100%;grid-template-columns:repeat(3,minmax(0,1fr))}}
.model-rotate-buttons{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px;flex:1;min-width:420px}@media(max-width:600px){.model-rotate-buttons{min-width:0;width:100%;flex-basis:100%;grid-template-columns:repeat(2,minmax(0,1fr))}.model-rotate-buttons button:last-child{grid-column:1 / -1}}
.model-exit-fullscreen{position:absolute;right:max(16px,env(safe-area-inset-right));top:max(16px,env(safe-area-inset-top));z-index:4;min-height:44px;padding:10px 16px;border:1px solid #b6d4c4;border-radius:10px;background:#fffffff2;color:#174e3d;box-shadow:0 2px 14px #1234;cursor:pointer}
.project-model.model-expanded{position:fixed;inset:0;width:100%;height:100%;height:100dvh;z-index:2000;background:#eef5f1;padding:0;margin:0;overflow:hidden;overscroll-behavior:none}
.project-model.model-expanded .model-canvas{position:absolute;inset:0;width:100%;height:100%;min-height:0;max-height:none;border-radius:0}
.model-expanded .model-toolbars{position:absolute;z-index:3;bottom:max(12px,env(safe-area-inset-bottom));left:16px;right:16px;max-height:38%;overflow:auto;background:#fffffff0;border:1px solid #d6e7dc;border-radius:12px;padding:10px}
.model-expanded .model-controls{margin-top:0}.model-expanded .model-navigation{margin-bottom:6px;padding:6px 10px}.model-expanded .model-navigation-title small{display:none}
.model-expanded > .project-muted,.model-expanded > details,.model-expanded > .project-error:not(.model-error),.model-expanded .model-updating{display:none}
.model-expanded > .model-error{position:absolute;z-index:3;top:64px;left:16px;right:16px;background:#fff4ee;padding:12px;border-radius:10px}
@media(max-width:700px),(hover:none) and (pointer:coarse){.model-navigation{display:none}.model-expanded .model-toolbars{display:none}}

.model-controls{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap;margin:8px 0 14px}.model-controls label{display:grid;gap:4px;font-size:12px;color:#587566}.model-controls .model-entity-toggle{display:flex;flex-direction:row;align-items:center;gap:6px;align-self:center}.model-controls .model-entity-toggle input{width:16px;height:16px;accent-color:#138357}.model-controls input{width:100px;padding:8px;border:1px solid #c3d7cb;border-radius:8px;color:#174e3d}.model-canvas{position:relative;height:60vh;min-height:320px;max-height:720px;border-radius:12px;overflow:hidden;background:#eef5f1}.model-canvas :deep(canvas){display:block;width:100%;height:100%;touch-action:none}.model-placeholder{position:absolute;inset:0;display:grid;place-items:center;padding:24px;text-align:center;color:#627d6c;pointer-events:none;z-index:1}.model-updating{position:absolute;right:12px;top:12px;padding:8px 12px;border-radius:20px;background:#fff9;color:#37694a;font-size:12px;pointer-events:none}details ul{max-height:220px;overflow:auto;overflow-wrap:anywhere}@media(max-width:600px){.model-canvas{height:48vh}.model-controls{gap:6px}.model-controls .model-entity-toggle{display:flex;flex-direction:row;align-items:center;gap:6px;align-self:center}.model-controls .model-entity-toggle input{width:16px;height:16px;accent-color:#138357}.model-controls input{width:90px}.model-controls button{font-size:12px;padding:8px}}
</style>
