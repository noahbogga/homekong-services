// ===== CONFIG =====
const ROOTS = [
  { name: 'Media', path: '/Media', icon: '🎬' },
  { name: 'fxMain', path: '/fxMain', icon: '🎮' },
  { name: 'fxTest', path: '/fxTest', icon: '🧪' },
];
// Personal storage path (per-user, hidden from roots)
function getPersonalPath() { return '/.userdata/' + (localStorage.getItem('hk_user') || 'noah') + '/storage'; }

// ===== STATE =====
let token = localStorage.getItem('hk_token') || '';
let currentPath = '/.userdata/' + (localStorage.getItem('hk_user') || 'noah') + '/storage';
let currentRoot = '/.userdata/' + (localStorage.getItem('hk_user') || 'noah') + '/storage';
let items = [];
let selectedSet = new Set();
let activeIdx = -1;
let viewMode = localStorage.getItem('hk_view') || 'grid';
let sidebarOpen = localStorage.getItem('hk_sidebar') !== 'false';
let uploadQueue = [];
let dragCounter = 0;
let treeCache = {};
let treeExpanded = new Set();
let longPressTimer = null;
let multiSelectMode = false;

// ===== INIT =====
function init() {
  const savedPref = localStorage.getItem('hk_sidebar');
  if (savedPref !== null) {
    sidebarOpen = savedPref === 'true';
  } else {
    sidebarOpen = window.innerWidth >= 768;
  }
  if (token) { showApp(); renderSidebar(); navigate(currentPath); }
  else showLogin();
  setupDragDrop();
  window.addEventListener('resize', ()=>{ updateSidebarState(); });
}
function showLogin() { document.getElementById('login-view').style.display='flex'; document.getElementById('app-view').style.display='none'; }
function showApp() { document.getElementById('login-view').style.display='none'; const av=document.getElementById('app-view'); av.style.display='flex'; av.classList.remove('hidden'); updateSidebarState(); }

// ===== AUTH =====
document.getElementById('loginForm').addEventListener('submit', async(e)=>{
  e.preventDefault();
  const user=document.getElementById('login-user').value.trim(), pass=document.getElementById('login-pass').value;
  const errEl=document.getElementById('login-error'); errEl.textContent='';
  try{ const res=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:user,password:pass})}); if(!res.ok){errEl.textContent='Invalid credentials';return;} token=await res.text(); localStorage.setItem('hk_token',token); localStorage.setItem('hk_user',user); showApp(); renderSidebar(); navigate(currentPath); }catch(e){errEl.textContent='Connection error';}
});
function logout(){token='';localStorage.removeItem('hk_token');localStorage.removeItem('hk_user');showLogin();}
function api(path,opts={}){opts.headers=opts.headers||{};opts.headers['X-Auth']=token;return fetch('/api'+path,opts);}

// ===== SIDEBAR =====
function toggleSidebar(){ sidebarOpen=!sidebarOpen; localStorage.setItem('hk_sidebar',sidebarOpen); updateSidebarState(); }
function updateSidebarState(){
  const sb=document.getElementById('sidebar');
  const btn=document.getElementById('sidebar-toggle-btn');
  const backdrop=document.getElementById('sidebar-backdrop');
  const isMobile=window.innerWidth<768;
  const sidebarW=isMobile?'200px':'240px';

  if(isMobile){
    sb.style.position='fixed';
    sb.style.left='0';
    sb.style.top=(document.getElementById('breadcrumb-bar').offsetTop+document.getElementById('breadcrumb-bar').offsetHeight)+'px';
    sb.style.bottom='0';
    sb.style.boxShadow='4px 0 20px rgba(0,0,0,.5)';
    if(sidebarOpen){
      sb.style.width=sidebarW;
      sb.style.transform='translateX(0)';
      sb.style.overflow='';
      backdrop.classList.remove('hidden');
    } else {
      sb.style.width=sidebarW;
      sb.style.transform='translateX(-100%)';
      sb.style.overflow='hidden';
      backdrop.classList.add('hidden');
    }
  } else {
    sb.style.position='relative';
    sb.style.left='';
    sb.style.top='';
    sb.style.bottom='';
    sb.style.boxShadow='none';
    sb.style.transform='none';
    if(sidebarOpen){
      sb.style.width=sidebarW;
      sb.style.overflow='';
    } else {
      sb.style.width='0';
      sb.style.overflow='hidden';
    }
    if(backdrop)backdrop.classList.add('hidden');
  }
  btn.textContent=sidebarOpen?'✕':'☰';
}

async function renderSidebar(){
  const sb=document.getElementById('sidebar-tree');
  let html='';

  // Personal storage (top, separated)
  const personalPath=getPersonalPath();
  const personalActive=currentPath.startsWith(personalPath);
  const personalExpanded=treeExpanded.has(personalPath);
  html+=`<div class="py-1 mb-1 pb-1 border-b border-white/[.05]">`;
  html+=`<div class="tree-root-label flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-purple-300/80 cursor-pointer hover:bg-purple-400/10 rounded-r mr-1.5 ${personalActive?'bg-purple-400/[.12]':''}" data-path="${personalPath}" ondragover="onTreeDragOver(event,'${personalPath}')" ondragleave="onTreeDragLeave(event)" ondrop="onTreeDrop(event,'${personalPath}')">`;
  html+=`<span class="w-5 h-5 flex items-center justify-center text-[.65rem] text-purple-300/50 cursor-pointer rounded hover:bg-purple-400/20 hover:text-purple-300" onclick="event.stopPropagation();toggleTreeNode('${personalPath}')">${personalExpanded?'▼':'▶'}</span>`;
  html+=`<span onclick="navigate('${personalPath}');currentRoot='${personalPath}';if(!treeExpanded.has('${personalPath}'))toggleTreeNode('${personalPath}');" class="flex-1">Personal</span>`;
  html+=`</div>`;
  if(personalExpanded){
    html+=`<div class="pl-3 tree-expand-anim">`;
    html+=await renderTreeLevel(personalPath,1);
    html+=`</div>`;
  }
  html+=`</div>`;

  // Server label
  html+=`<div class="px-3.5 py-1 text-[.55rem] text-white/20 uppercase tracking-wider">Server</div>`;

  for(const root of ROOTS){
    const isActive=currentPath.startsWith(root.path);
    const expanded=treeExpanded.has(root.path);
    html+=`<div class="py-1">`;
    html+=`<div class="tree-root-label flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-gold cursor-pointer hover:bg-gold-glow rounded-r mr-1.5 ${isActive?'bg-gold/[.12]':''}" data-path="${root.path}" ondragover="onTreeDragOver(event,'${root.path}')" ondragleave="onTreeDragLeave(event)" ondrop="onTreeDrop(event,'${root.path}')">`;
    html+=`<span class="w-5 h-5 flex items-center justify-center text-[.65rem] text-gold-dim cursor-pointer rounded hover:bg-gold/20 hover:text-gold" onclick="event.stopPropagation();toggleTreeNode('${root.path}')">${expanded?'▼':'▶'}</span>`;
    html+=`<span onclick="switchRoot('${root.path}');if(!treeExpanded.has('${root.path}'))toggleTreeNode('${root.path}');" class="flex-1">${root.icon} ${root.name}</span>`;
    html+=`</div>`;
    if(expanded){
      html+=`<div class="pl-3 tree-expand-anim">`;
      html+=await renderTreeLevel(root.path,1);
      html+=`</div>`;
    }
    html+=`</div>`;
  }
  sb.innerHTML=html;
  renderBreadcrumb();
}

async function renderTreeLevel(path,depth){
  if(!treeCache[path]){
    try{ const res=await api('/resources'+path); if(res.ok){const d=await res.json(); treeCache[path]=(d.items||[]).filter(i=>i.isDir).sort((a,b)=>a.name.localeCompare(b.name));} else treeCache[path]=[]; }catch(e){treeCache[path]=[];}
  }
  const folders=treeCache[path];
  if(!folders.length) return '';
  let html='';
  for(const f of folders){
    const fPath=path+(path.endsWith('/')?'':'/')+f.name;
    const expanded=treeExpanded.has(fPath);
    const isActive=currentPath===fPath;
    const pad=depth*12;
    html+=`<div class="tree-item flex items-center gap-1.5 py-1 px-2.5 text-[.7rem] text-cream-dim cursor-pointer rounded hover:bg-hk-card hover:text-cream ${isActive?'bg-gold/[.08] !text-gold':''}" data-path="${fPath}" style="padding-left:${pad}px;" ondragover="onTreeDragOver(event,'${fPath}')" ondragleave="onTreeDragLeave(event)" ondrop="onTreeDrop(event,'${fPath}')" onclick="navigate('${fPath}');if(!treeExpanded.has('${fPath}')){toggleTreeNode('${fPath}');}">`;
    html+=`<span class="w-4 h-4 flex items-center justify-center text-[.55rem] text-cream-dim cursor-pointer rounded hover:bg-white/10 hover:text-cream flex-shrink-0" onclick="event.stopPropagation();toggleTreeNode('${fPath}')">${expanded?'▼':'▶'}</span>`;
    html+=`<span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap flex items-center gap-1"><img src="/assets/folder.png" class="w-4 h-4 inline"> ${f.name}</span></div>`;
    if(expanded) html+=await renderTreeLevel(fPath,depth+1);
  }
  return html;
}

async function toggleTreeNode(path){
  if(treeExpanded.has(path)) treeExpanded.delete(path);
  else treeExpanded.add(path);
  await renderSidebar();
}
function switchRoot(path){ currentRoot=path; navigate(path); }

// ===== NAVIGATION =====
// navigate() is defined in the STATUS BAR section below (wraps with status indicators)

function renderBreadcrumb(){
  const parts=currentPath.split('/').filter(Boolean);
  const rootName=ROOTS.find(r=>r.path===currentRoot)?.name||'Root';
  const rootParts=currentRoot.split('/').filter(Boolean);
  const subParts=parts.slice(rootParts.length);
  let html=`<span onclick="navigate('${currentRoot}')" ondblclick="event.stopPropagation();copyPath('${currentRoot}')" oncontextmenu="event.preventDefault();copyPath('${currentRoot}')" class="cursor-pointer text-sky-300/70 hover:text-sky-200 transition inline-flex items-center gap-1"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1L1 7h2v6h4V9h2v4h4V7h2L8 1z"/></svg> ${rootName}</span>`;
  let built=currentRoot;
  subParts.forEach((p,i)=>{built+=(built.endsWith('/')?'':'/')+p;const isLast=i===subParts.length-1;const bp=built;html+=` <span class="text-sky-400/40 cursor-default">/</span> `;html+=`<span class="cursor-pointer text-sky-300/70 hover:text-sky-200 transition ${isLast?'!text-sky-100':''}" onclick="navigate('${bp}')" ondblclick="event.stopPropagation();copyPath('${bp}')" oncontextmenu="event.preventDefault();copyPath('${bp}')">${p}</span>`;});
  document.getElementById('breadcrumb-inline').innerHTML=html;
}
function copyPath(p){
  const pathToCopy=p||currentPath;
  navigator.clipboard.writeText(pathToCopy).then(()=>toast('Copied: '+pathToCopy,'success')).catch(()=>toast(pathToCopy,'info'));
}
function triggerBreadcrumbShimmer(){
  const bar=document.getElementById('breadcrumb-bar');
  bar.classList.remove('shimmer');
  void bar.offsetWidth;
  bar.classList.add('shimmer');
  setTimeout(()=>bar.classList.remove('shimmer'),700);
}

// ===== RENDER FILES =====
function renderFiles(){
  const list=document.getElementById('file-list');
  const isGrid=viewMode==='grid';
  // Hide Resolver folder from normal listing (shown as special pinned item)
  const isPersonalRoot = currentPath === getPersonalPath();
  if(!items.length){
    let empty='';
    if(currentPath!==currentRoot) empty+=isGrid?renderBackRowGrid():renderBackRow();
    if(isPersonalRoot) empty+=isGrid?_renderResolverShortcutGrid():_renderResolverShortcutList();
    empty+='<p class="text-center py-8 text-cream-dim text-sm">Empty folder</p>';
    list.className=isGrid?'flex-1 overflow-y-auto px-3 sm:px-5 py-2 pb-20 grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] sm:grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2 sm:gap-2.5 content-start':'flex-1 overflow-y-auto px-3 sm:px-5 py-2 pb-20';
    list.innerHTML=empty;return;
  }
  list.className=isGrid?'flex-1 overflow-y-auto px-3 sm:px-5 py-2 pb-20 grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] sm:grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2 sm:gap-2.5 content-start':'flex-1 overflow-y-auto px-3 sm:px-5 py-2 pb-20';
  updateViewToggleIcon();
  // Filter out Resolver folder from normal items when in personal root
  const filteredItems = isPersonalRoot ? items.filter(i => i.name !== 'Resolver') : items;
  const folders=filteredItems.filter(i=>i.isDir), files=filteredItems.filter(i=>!i.isDir);
  let html='';
  // Show Resolver shortcut at top in personal root
  if(isPersonalRoot) html+=isGrid?_renderResolverShortcutGrid():_renderResolverShortcutList();
  if(!isGrid){
    html+=`<div class="hidden sm:grid grid-cols-[36px_1fr_80px_120px_120px] px-3 py-1 text-[.6rem] text-cream-dim uppercase tracking-wider border-b border-gold/[.08]"><span></span><span>Name</span><span class="text-right">Size</span><span class="text-right">Created</span><span class="text-right">Modified</span></div>`;
    if(currentPath!==currentRoot) html+=renderBackRow();
    folders.forEach(item=>{html+=renderListItem(item,items.indexOf(item));});
    if(folders.length&&files.length) html+='<hr class="border-none border-t border-gold/[.15] my-1.5">';
    files.forEach(item=>{html+=renderListItem(item,items.indexOf(item));});
  } else {
    if(currentPath!==currentRoot) html+=renderBackRowGrid();
    folders.forEach(item=>{html+=renderGridItem(item,items.indexOf(item));});
    files.forEach(item=>{html+=renderGridItem(item,items.indexOf(item));});
  }
  list.innerHTML=html; updateToolbar();
}

function renderBackRow(){return `<div class="grid grid-cols-[36px_1fr] sm:grid-cols-[36px_1fr_80px_120px_120px] items-center px-3 py-3 sm:py-2 rounded cursor-pointer hover:bg-hk-card gap-2 sm:gap-1.5" ondragover="onBackDragOver(event)" ondragleave="event.currentTarget.classList.remove('item-drag-over')" ondrop="onBackDrop(event)" onclick="navigateUp()"><div class="text-lg text-center">⬅</div><div class="text-sm sm:text-xs text-cream-dim">..</div><div class="hidden sm:block"></div><div class="hidden sm:block"></div><div class="hidden sm:block"></div></div>`;}
function renderBackRowGrid(){return `<div class="flex flex-col items-center p-3 text-center cursor-pointer rounded hover:bg-hk-card gap-1" ondragover="onBackDragOver(event)" ondragleave="event.currentTarget.classList.remove('item-drag-over')" ondrop="onBackDrop(event)" onclick="navigateUp()"><div class="text-2xl">⬅</div><div class="text-[.65rem] text-cream-dim">Back</div></div>`;}

// Resolver shortcut (pinned at top of Personal storage)
function _renderResolverShortcutGrid(){return `<div class="flex flex-col items-center p-3 text-center cursor-pointer rounded hover:bg-yellow-400/5 gap-1 border border-yellow-400/10" onclick="navigate(getPersonalPath()+'/Resolver')"><div class="text-2xl">⚡</div><div class="text-[.65rem] text-yellow-400/70">Resolver</div></div>`;}
function _renderResolverShortcutList(){return `<div class="grid grid-cols-[36px_1fr] sm:grid-cols-[36px_1fr_80px_120px_120px] items-center px-3 py-3 sm:py-2 rounded cursor-pointer hover:bg-yellow-400/5 gap-2 sm:gap-1.5 border border-yellow-400/10" onclick="navigate(getPersonalPath()+'/Resolver')"><div class="text-lg text-center">⚡</div><div class="text-sm sm:text-xs text-yellow-400/70">Resolver</div><div class="hidden sm:block"></div><div class="hidden sm:block"></div><div class="hidden sm:block"></div></div>`;}

function getIconHtml(item){
  const isImg=isImageFile(item.name)&&item.size>1024;
  if(item.isDir)return '<img src="/assets/folder.png" class="w-6 h-6 sm:w-7 sm:h-7" alt="folder">';
  if(isImg){const p='/api/raw'+encodeURI(currentPath+(currentPath.endsWith('/')?'':'/')+item.name)+'?auth='+token;return `<img src="${p}" alt="" loading="lazy" class="w-7 h-7 sm:w-7 sm:h-7 object-cover rounded" onerror="this.outerHTML='🖼'">`;}
  return getFileIcon(item.name);
}

function renderListItem(item,idx){
  const isCurrent=idx===activeIdx&&selectedSet.has(idx);
  const isSelected=selectedSet.has(idx);
  const isCut=clipboard.mode==='cut'&&clipboard.items.some(c=>c.name===item.name&&clipboard.sourcePath===currentPath);
  const bgCls=isCurrent?'bg-gold/10 outline outline-1 outline-gold-dim':isSelected?'bg-gold/[.05] outline outline-1 outline-gold/20':'';
  const cutStyle=isCut?'opacity:0.4;':'';
  const size=item.isDir?`${item.numFiles||0} items`:formatSize(item.size);
  const created=item.created?formatDate(item.created):'—';
  const modified=item.modified?formatDate(item.modified):'—';
  const isMobile=window.innerWidth<768||('ontouchstart' in window);
  const draggable=isMobile?'false':'true';
  let h=`<div class="file-item grid grid-cols-[36px_1fr] sm:grid-cols-[36px_1fr_80px_120px_120px] items-center px-3 py-3 sm:py-2 rounded cursor-pointer hover:bg-hk-card gap-2 sm:gap-1.5 relative ${bgCls}" data-idx="${idx}" draggable="${draggable}" style="${cutStyle}" ondragstart="onItemDragStart(event,${idx})" ondragover="onItemDragOver(event,${idx})" ondragleave="onItemDragLeave(event)" ondrop="onItemDrop(event,${idx})" onclick="handleClick(${idx},event)" ondblclick="handleDblClick(${idx})" ontouchstart="onItemTouchStart(${idx},event)" ontouchend="onItemTouchEnd(event)" ontouchmove="onItemTouchMove(event)">`;
  if(multiSelectMode&&(isSelected||isCurrent)) h+=`<span class="absolute top-1/2 -translate-y-1/2 left-1 text-[.45rem] text-gold font-bold bg-hk-light rounded px-0.5">✓</span>`;
  h+=`<div class="text-lg sm:text-base text-center">${getIconHtml(item)}</div>`;
  h+=`<div class="text-sm sm:text-xs overflow-hidden text-ellipsis whitespace-nowrap">${item.name}</div>`;
  h+=`<div class="hidden sm:block text-[.65rem] text-cream-dim text-right">${size}</div>`;
  h+=`<div class="hidden sm:block text-[.6rem] text-cream-dim text-right">${created}</div>`;
  h+=`<div class="hidden sm:block text-[.6rem] text-cream-dim text-right">${modified}</div>`;
  h+=`</div>`;
  return h;
}

function renderGridItem(item,idx){
  const isCurrent=idx===activeIdx&&selectedSet.has(idx);
  const isSelected=selectedSet.has(idx);
  const isCut=clipboard.mode==='cut'&&clipboard.items.some(c=>c.name===item.name&&clipboard.sourcePath===currentPath);
  const bgCls=isCurrent?'bg-gold/10 outline outline-1 outline-gold-dim':isSelected?'bg-gold/[.05] outline outline-1 outline-gold/20':'';
  const cutStyle=isCut?'opacity:0.4;':'';
  const isMobile=window.innerWidth<768||('ontouchstart' in window);
  const draggable=isMobile?'false':'true';
  let h=`<div class="file-item flex flex-col items-center p-3 text-center cursor-pointer rounded hover:bg-hk-card gap-1 relative ${bgCls}" data-idx="${idx}" draggable="${draggable}" style="${cutStyle}" ondragstart="onItemDragStart(event,${idx})" ondragover="onItemDragOver(event,${idx})" ondragleave="onItemDragLeave(event)" ondrop="onItemDrop(event,${idx})" onclick="handleClick(${idx},event)" ondblclick="handleDblClick(${idx})" ontouchstart="onItemTouchStart(${idx},event)" ontouchend="onItemTouchEnd(event)" ontouchmove="onItemTouchMove(event)">`;
  if(multiSelectMode&&(isSelected||isCurrent)) h+=`<span class="absolute top-1 right-1.5 text-[.5rem] text-gold font-bold bg-hk-light rounded px-1">✓</span>`;
  h+=`<div class="text-2xl">${getIconHtml(item)}</div>`;
  h+=`<div class="text-[.65rem] whitespace-normal break-words line-clamp-2 w-full overflow-hidden">${item.name}</div>`;
  h+=`</div>`;
  return h;
}
// ===== UTILS =====
function isImageFile(name){if(name.startsWith('._')||name.startsWith('.__'))return false;const ext=name.split('.').pop().toLowerCase();return['jpg','jpeg','png','gif','webp','svg','bmp','ico'].includes(ext);}
function isTextFile(name){const ext=name.split('.').pop().toLowerCase();return['txt','log','md','json','js','ts','lua','py','cfg','xml','yml','yaml','ini','html','css','meta','conf','sh','bat','ps1','sql','csv'].includes(ext);}
function isVideoFile(name){const ext=name.split('.').pop().toLowerCase();return['mp4','webm','mkv','avi','mov','m4v'].includes(ext);}
// Icon helper for confirm/paste modals — differentiates folder/image/text/video/misc
function getConfirmItemIcon(name,isDir){
  if(isDir)return '<img src="/assets/folder.png" class="w-4 h-4 inline align-middle">';
  if(isImageFile(name))return '<span class="inline align-middle">🖼</span>';
  if(isVideoFile(name))return '<span class="inline align-middle">🎬</span>';
  if(isTextFile(name))return '<span class="inline align-middle">📝</span>';
  return '<span class="inline align-middle">📄</span>';
}
function formatSize(b){if(!b)return'—';const u=['B','KB','MB','GB'];let i=0;while(b>=1024&&i<3){b/=1024;i++;}return b.toFixed(i>0?1:0)+' '+u[i];}
function formatDate(d){if(!d)return'—';const dt=new Date(d);return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')} ${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;}
function getFileIcon(name){const ext=name.split('.').pop().toLowerCase();const m={jpg:'🖼',jpeg:'🖼',png:'🖼',gif:'🖼',webp:'🖼',svg:'🖼',mp4:'🎬',webm:'🎬',mkv:'🎬',mp3:'🎵',wav:'🎵',flac:'🎵',pdf:'📄',doc:'📄',docx:'📄',txt:'📄',zip:'📦',rar:'📦','7z':'📦',tar:'📦',js:'⚙️',json:'⚙️',lua:'⚙️',py:'⚙️',cfg:'⚙️',xml:'⚙️',yml:'⚙️',meta:'⚙️'};return m[ext]||'📄';}
function downloadBlob(blob,name){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();URL.revokeObjectURL(url);}
function toast(msg,type='info'){const el=document.getElementById('toast');el.textContent=msg;el.style.borderColor=type==='error'?'#e74c3c':type==='success'?'#27ae60':'rgba(194,163,90,0.5)';el.classList.add('show');el.style.display='block';setTimeout(()=>{el.classList.remove('show');el.style.display='none';},3000);}

// Custom right-click context menu
document.addEventListener('contextmenu',e=>{
  const fileItem=e.target.closest('.file-item');
  if(!fileItem)return;
  e.preventDefault();
  const idx=parseInt(fileItem.dataset.idx);
  if(isNaN(idx))return;
  // Select the item
  if(!selectedSet.has(idx)){selectedSet.clear();selectedSet.add(idx);activeIdx=idx;renderFiles();}
  _showContextMenu(e.clientX,e.clientY,idx);
});

function _showContextMenu(x,y,idx){
  // Remove existing
  const old=document.getElementById('ctx-menu');if(old)old.remove();

  const item=items[idx];
  const isDir=item?.isDir;
  const multi=selectedSet.size>1;

  let options=[];
  if(!multi){
    if(isDir) options.push({label:'Open',icon:'📂',action:()=>handleDblClick(idx)});
    else options.push({label:'Open',icon:'📄',action:()=>handleDblClick(idx)});
  }
  options.push({label:'Download',icon:'⬇',action:()=>downloadSelected()});
  if(!isDir&&!multi) options.push({label:'Share',icon:'🔗',action:()=>shareItem(idx)});
  if(!isDir) options.push({label:'Convert/Resize',icon:'🔄',action:()=>openConvertModal(idx)});
  if(multi||isDir) options.push({label:"Pack as ZIP",icon:"📦",action:()=>packAsZip()});
  options.push({sep:true});
  options.push({label:'Rename',icon:'✏',action:()=>renameSelected()});
  options.push({label:'Copy',icon:'⧉',action:()=>copySelected()});
  options.push({label:'Cut',icon:'✂',action:()=>cutSelected()});
  if(clipboard.items.length) options.push({label:'Paste',icon:'📋',action:()=>confirmPaste()});
  options.push({label:'Move to...',icon:'↪',action:()=>moveSelected()});
  options.push({label:'Duplicate',icon:'⧉',action:()=>duplicateSelected()});
  options.push({sep:true});
  options.push({label:'Delete',icon:'🗑',action:()=>deleteSelected(),danger:true});
  options.push({sep:true});
  options.push({label:'Copy path',icon:'📋',action:()=>copyPath(getItemPath(idx))});
  if(!isDir&&!multi) options.push({label:"Scan for viruses",icon:"🛡",action:()=>scanViruses(idx)});
  options.push({label:'Info',icon:'ℹ',action:()=>infoItem(idx)});

  const menu=document.createElement('div');
  menu.id='ctx-menu';
  menu.style.cssText=`position:fixed;left:${x}px;top:${y}px;z-index:100000;min-width:160px;background:rgba(18,22,35,0.95);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:4px;box-shadow:0 8px 32px rgba(0,0,0,0.5);`;

  options.forEach(opt=>{
    if(opt.sep){menu.insertAdjacentHTML('beforeend','<div style="height:1px;background:rgba(255,255,255,0.05);margin:3px 8px;"></div>');return;}
    const color=opt.danger?'color:#ef4444;':'color:rgba(255,255,255,0.8);';
    menu.insertAdjacentHTML('beforeend',`<div class="ctx-item" style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:12px;${color}transition:background .1s;" onmouseover="this.style.background='rgba(255,255,255,0.06)'" onmouseout="this.style.background='none'"><span style="width:16px;text-align:center;font-size:11px;">${opt.icon}</span><span>${opt.label}</span></div>`);
  });

  // Position: keep on screen
  document.body.appendChild(menu);
  const rect=menu.getBoundingClientRect();
  if(rect.right>window.innerWidth)menu.style.left=(window.innerWidth-rect.width-8)+'px';
  if(rect.bottom>window.innerHeight)menu.style.top=(window.innerHeight-rect.height-8)+'px';

  // Click actions
  menu.addEventListener('click',e=>{
    const item=e.target.closest('.ctx-item');
    if(!item)return;
    const i=[...menu.querySelectorAll('.ctx-item')].indexOf(item);
    const opt=options.filter(o=>!o.sep)[i];
    if(opt&&opt.action)opt.action();
    menu.remove();
  });

  // Close on click outside or scroll
  setTimeout(()=>{
    const close=()=>{menu.remove();document.removeEventListener('click',close);document.removeEventListener('scroll',close,true);};
    document.addEventListener('click',close);
    document.addEventListener('scroll',close,true);
  },10);
}
function _showContextMenuFromToolbar() {
  if (activeIdx >= 0) _showContextMenu(window.innerWidth / 2, window.innerHeight - 200, activeIdx);
  else if (selectedSet.size > 0) _showContextMenu(window.innerWidth / 2, window.innerHeight - 200, [...selectedSet][0]);
}

document.querySelectorAll('.modal-overlay').forEach(el=>{el.addEventListener('click',e=>{if(e.target===el){el.classList.add('hidden');el.classList.remove('flex');}});});
