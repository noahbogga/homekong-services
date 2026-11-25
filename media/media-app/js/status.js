// ===== AUTO-REFRESH =====
let lastItemsHash='';let pollInterval=null;
function getItemsHash(itemList){return itemList.map(i=>i.name+'|'+i.size+'|'+i.modified).join(';');}
let isNavigating=false;
function startPolling(){
  if(pollInterval)clearInterval(pollInterval);
  pollInterval=setInterval(async()=>{
    if(!token||!currentPath||isNavigating)return;
    if(document.querySelector('.modal-overlay:not(.hidden)')||document.getElementById('viewer').classList.contains('flex'))return;
    try{
      const res=await api('/resources'+currentPath);if(!res.ok)return;
      const d=await res.json();let newItems=(d.items||[]).filter(i=>i.name!=='.recycle'&&i.name!=='.meta.json'&&i.name!=='.userdata');
      const newHash=getItemsHash(newItems);
      if(lastItemsHash&&newHash!==lastItemsHash){
        items=newItems;items.sort((a,b)=>{if(a.isDir&&!b.isDir)return -1;if(!a.isDir&&b.isDir)return 1;return a.name.localeCompare(b.name);});
        renderFiles();treeCache={};renderSidebar();
      }
      lastItemsHash=newHash;
    }catch(e){}
  },3000);
}
function stopPolling(){if(pollInterval){clearInterval(pollInterval);pollInterval=null;}}

// ===== VERSION CHECK =====
const APP_VERSION=Date.now().toString(36);
(function checkVersion(){
  setInterval(async()=>{
    try{
      const res=await fetch('/?_vc='+Date.now(),{method:'HEAD',cache:'no-store'});
      const serverLen=res.headers.get('content-length');const serverMod=res.headers.get('last-modified');
      if(!window._appLen){window._appLen=serverLen;window._appMod=serverMod;return;}
      if(serverLen!==window._appLen||serverMod!==window._appMod){toast('Update available — reloading...','info');setTimeout(()=>location.reload(),1500);}
    }catch(e){}
  },60000);
})();

// ===== STATUS BAR =====
let statusState={level:'green',msg:'Ready',error:null};
let clientIP='';

// Status levels: green (idle/ok), yellow (loading/pending), red (dismissable error), critical (non-dismissable)
function setStatus(level,msg,error){
  statusState={level,msg,error:error||null};
  const light=document.getElementById('status-light');
  const msgEl=document.getElementById('status-msg');
  const dismissBtn=document.getElementById('status-dismiss');
  const reportBtn=document.getElementById('status-report');
  if(!light)return;

  // Light color + animation
  light.className='w-2 h-2 rounded-full flex-shrink-0';
  if(level==='green'){
    light.classList.add('bg-success');
  } else if(level==='yellow'){
    light.classList.add('bg-amber-400','pulse');
  } else if(level==='red'){
    light.classList.add('bg-danger','blink-slow');
  } else if(level==='critical'){
    light.classList.add('bg-danger','blink-fast');
  } else if(level==='transfer'){
    light.classList.add('bg-success','blink-fast');
  } else if(level==='transfer-slow'){
    light.classList.add('bg-success','blink-slow');
  }

  msgEl.textContent=msg;
  msgEl.className='truncate '+((level==='red'||level==='critical')?'text-danger':level==='yellow'?'text-amber-400':'text-cream-dim');

  // Dismiss: only for non-critical errors
  dismissBtn.classList.toggle('hidden',level!=='red');
  // Report: show for any error
  reportBtn.classList.toggle('hidden',level!=='red'&&level!=='critical');
}

function dismissStatus(){
  setStatus('green','Ready');
}

async function reportStatus(){
  if(!statusState.error)return;
  try{
    await fetch('/search-api/report',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        error:statusState.error,
        msg:statusState.msg,
        path:currentPath,
        user:localStorage.getItem('hk_user')||'unknown',
        ip:clientIP,
        time:new Date().toISOString(),
        ua:navigator.userAgent
      })
    });
    toast('Error reported','success');
    dismissStatus();
  }catch(e){toast('Report failed','error');}
}

// Clock update
function updateClock(){
  const el=document.getElementById('status-clock');
  if(!el)return;
  const now=new Date();
  el.textContent=now.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
setInterval(updateClock,1000);

// Get client IP
async function fetchClientIP(){
  try{
    const r=await fetch('https://api.ipify.org?format=json');
    if(r.ok){const d=await r.json();clientIP=d.ip;const el=document.getElementById('status-ip');if(el){el.textContent=clientIP;el.classList.remove('hidden');}}
  }catch(e){/* silent */}
}

// Hook into navigate to show yellow during loading
async function navigate(path){
  // Block direct access to .userdata unless via personal path
  if(path.includes('.userdata') && !path.startsWith(getPersonalPath())){
    toast('Access denied','error'); return;
  }
  setStatus('yellow','Loading '+path.split('/').pop()+'...');
  isNavigating=true;
  currentPath=path;activeIdx=-1;selectedSet.clear();multiSelectMode=false;
  for(const r of ROOTS){if(path.startsWith(r.path)){currentRoot=r.path;break;}}
  renderBreadcrumb();updateToolbar();triggerBreadcrumbShimmer();
  document.getElementById('file-list').innerHTML='<div class="flex flex-col items-center justify-center py-12 gap-3"><div class="hk-spinner"></div><p class="text-cream-dim text-xs">Loading</p></div>';
  try{
    const res=await api('/resources'+path);
    if(res.status===401){logout();return;}
    if(!res.ok){setStatus('red','Failed to load: '+res.status,'HTTP '+res.status+' on '+path);toast('Failed to load','error');isNavigating=false;return;}
    const d=await res.json();items=d.items||[];
    items=items.filter(i=>i.name!=='.recycle'&&i.name!=='.meta.json'&&i.name!=='.userdata');
    items.sort((a,b)=>{if(a.isDir&&!b.isDir)return -1;if(!a.isDir&&b.isDir)return 1;return a.name.localeCompare(b.name);});
    renderFiles();
    lastItemsHash=getItemsHash(items);
    setStatus('green',items.length+' items · '+path.split('/').pop());
  }catch(e){setStatus('critical','Connection lost: '+e.message,e.message);toast('Network error','error');}
  isNavigating=false;
  renderSidebar();
}

// ===== BOOT =====
init();
startPolling();
updateClock();
fetchClientIP();

// Sidebar particles
(function(){
  var c=document.getElementById('sidebar-bg'),sb=document.getElementById('sidebar');
  if(!c)return;
  var ctx=c.getContext('2d'),particles=[];
  function resize(){c.width=sb.offsetWidth;c.height=sb.offsetHeight;if(!particles.length)initParticles();}
  function initParticles(){particles=[];for(var i=0;i<35;i++){particles.push({x:Math.random()*c.width,y:Math.random()*c.height,vx:(Math.random()-.5)*.15,vy:(Math.random()-.5)*.15,r:Math.random()*1.2+.4,a:Math.random()*.2+.08});}}
  new ResizeObserver(resize).observe(sb);resize();
  function draw(){ctx.clearRect(0,0,c.width,c.height);for(var i=0;i<particles.length;i++){var p=particles[i];p.x+=p.vx;p.y+=p.vy;if(p.x<0)p.x=c.width;if(p.x>c.width)p.x=0;if(p.y<0)p.y=c.height;if(p.y>c.height)p.y=0;ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);ctx.fillStyle='rgba(194,163,90,'+p.a+')';ctx.fill();}for(var i=0;i<particles.length;i++){for(var j=i+1;j<particles.length;j++){var dx=particles[i].x-particles[j].x,dy=particles[i].y-particles[j].y;var dist=Math.sqrt(dx*dx+dy*dy);if(dist<90){ctx.beginPath();ctx.moveTo(particles[i].x,particles[i].y);ctx.lineTo(particles[j].x,particles[j].y);ctx.strokeStyle='rgba(194,163,90,'+(0.06*(1-dist/90))+')';ctx.stroke();}}}requestAnimationFrame(draw);}draw();
})();
