// ===== UPLOAD =====
// Files above this go through the chunked /upload-api path. Cloudflare Business caps a
// single request body at 200MB, so big files can't use filebrowser's one-shot POST.
const CHUNK_THRESHOLD=100*1024*1024;
async function uploadFileChunked(path,file,overwrite,fileIdx,fileTotal,btn){
  try{
    const initRes=await fetch('/upload-api/init',{method:'POST',headers:{'X-Auth':token,'Content-Type':'application/json'},body:JSON.stringify({path,size:file.size,overwrite:!!overwrite})});
    if(initRes.status===409)return 409;
    if(!initRes.ok)return initRes.status;
    const {id,chunkSize}=await initRes.json();
    const cs=chunkSize||(64*1024*1024);
    const nChunks=Math.max(1,Math.ceil(file.size/cs));
    const label=btn?btn.querySelector('span'):null;
    for(let c=0;c<nChunks;c++){
      const start=c*cs,end=Math.min(file.size,start+cs);
      const blob=file.slice(start,end);
      let attempt=0,okChunk=false,st=0;
      while(attempt<3&&!okChunk){
        attempt++;
        const r=await fetch('/upload-api/chunk?id='+id+'&index='+c,{method:'POST',headers:{'X-Auth':token,'Content-Type':'application/octet-stream'},body:blob}).catch(()=>null);
        st=r?r.status:0;okChunk=!!(r&&r.ok);
        if(!okChunk)await new Promise(res=>setTimeout(res,500*attempt));
      }
      if(!okChunk){await fetch('/upload-api/abort?id='+id,{method:'POST',headers:{'X-Auth':token}}).catch(()=>{});return st||0;}
      if(label){const pct=Math.round(((c+1)/nChunks)*100);label.textContent=`Uploading ${fileIdx+1}/${fileTotal}... ${pct}%`;}
      const bar=document.getElementById('upload-progress-bar');
      if(bar){const overall=((fileIdx+(c+1)/nChunks)/fileTotal)*100;bar.style.width=overall.toFixed(1)+'%';}
    }
    const compRes=await fetch('/upload-api/complete?id='+id,{method:'POST',headers:{'X-Auth':token}});
    return compRes.status;
  }catch(e){return 0;}
}
let uploadLocation='';
function openUploadModal(){uploadQueue=[];uploadLocation=currentPath;renderUploadList();document.getElementById('upload-go').disabled=true;document.getElementById('upload-location').textContent=currentPath;document.getElementById('upload-modal').classList.remove('hidden');document.getElementById('upload-modal').classList.add('flex');}
function closeUpload(){document.getElementById('upload-modal').classList.add('hidden');document.getElementById('upload-modal').classList.remove('flex');uploadQueue=[];}
function changeUploadLocation(){
  moveBrowsePath=uploadLocation||currentPath;
  document.getElementById('move-modal').classList.remove('hidden');document.getElementById('move-modal').classList.add('flex');
  const origConfirmMove=window.confirmMove;
  window.confirmMove=function(){
    uploadLocation=moveBrowsePath;
    document.getElementById('upload-location').textContent=uploadLocation;
    document.getElementById('move-modal').classList.add('hidden');document.getElementById('move-modal').classList.remove('flex');
    window.confirmMove=origConfirmMove;
    const moveBtn=document.querySelector('#move-modal button[onclick="confirmMove()"]');
    if(moveBtn)moveBtn.textContent='Move Here';
  };
  const moveBtn=document.querySelector('#move-modal button[onclick="confirmMove()"]');
  if(moveBtn)moveBtn.textContent='Select This Location';
  renderMoveFolders();
}
document.getElementById('upload-zone').addEventListener('click',()=>document.getElementById('file-input').click());
document.getElementById('upload-zone').addEventListener('contextmenu',e=>{e.preventDefault();document.getElementById('folder-input').click();});
document.getElementById('file-input').addEventListener('change',e=>{addFilesToQueue([...e.target.files]);e.target.value='';});
document.getElementById('folder-input').addEventListener('change',e=>{addFilesToQueue([...e.target.files]);e.target.value='';});
document.getElementById('upload-zone').addEventListener('dragover',e=>{e.preventDefault();e.stopPropagation();e.currentTarget.classList.add('!border-gold','!bg-gold-glow');});
document.getElementById('upload-zone').addEventListener('dragleave',e=>{e.currentTarget.classList.remove('!border-gold','!bg-gold-glow');});
document.getElementById('upload-zone').addEventListener('drop',async e=>{e.preventDefault();e.stopPropagation();e.currentTarget.classList.remove('!border-gold','!bg-gold-glow');addFilesToQueue(await getDroppedFiles(e.dataTransfer));});

async function getDroppedFiles(dt){const files=[],entries=[];for(let i=0;i<dt.items.length;i++){const en=dt.items[i].webkitGetAsEntry?dt.items[i].webkitGetAsEntry():null;if(en)entries.push(en);}if(entries.length)await Promise.all(entries.map(e=>readEntry(e,'',files)));else for(const f of dt.files)files.push({file:f,relativePath:f.name});return files;}
function readEntry(entry,path,results){return new Promise(resolve=>{if(entry.isFile)entry.file(f=>{results.push({file:f,relativePath:path+f.name});resolve();});else if(entry.isDirectory){const reader=entry.createReader();const readAll=()=>{reader.readEntries(async entries=>{if(entries.length){await Promise.all(entries.map(e=>readEntry(e,path+entry.name+'/',results)));readAll();}else{resolve();}});};readAll();}else resolve();});}
function addFilesToQueue(files){for(const f of files){const item=f.file?f:{file:f,relativePath:f.webkitRelativePath||f.name};uploadQueue.push({...item,status:'pending'});}renderUploadList();document.getElementById('upload-go').disabled=uploadQueue.length===0;}
function renderUploadList(){document.getElementById('upload-file-list').innerHTML=uploadQueue.map((item,i)=>{const ext=item.relativePath.split('.').pop().toLowerCase();const typeIcon=item.status==='done'?'✅':item.status==='replaced'?'🔄':item.status==='skipped'?'⏭':item.status==='error'?'❌':item.status==='uploading'?'⏳':(['jpg','jpeg','png','gif','webp','svg'].includes(ext)?'🖼':['mp4','webm','mkv','avi','mov'].includes(ext)?'🎬':['mp3','wav','flac','ogg'].includes(ext)?'🎵':['zip','rar','7z','tar','gz'].includes(ext)?'📦':['js','json','lua','py','cfg','xml','yml'].includes(ext)?'⚙️':'📄');const canRemove=item.status==='pending';const color=item.status==='error'?'text-danger':item.status==='skipped'||item.status==='replaced'?'text-amber-400':'';return `<div class="flex items-center px-2 py-1.5 text-[.7rem] gap-1.5 rounded ${color}"><span class="${canRemove?'cursor-pointer hover:opacity-50':''}" ${canRemove?`onclick="removeFromUploadQueue(${i})" title="Remove"`:''}>${typeIcon}</span><span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">${item.relativePath}</span><span class="text-[.65rem] text-cream-dim">${formatSize(item.file.size)}</span></div>`;}).join('');}
function removeFromUploadQueue(idx){uploadQueue.splice(idx,1);renderUploadList();document.getElementById('upload-go').disabled=uploadQueue.length===0;}
async function startUpload(){
  const btn=document.getElementById('upload-go');
  if(uploadQueue.length>=1000){
    const pass=await showPromptModal(`Bulk upload: ${uploadQueue.length} files. Enter root password to continue:`,'');
    if(pass!=='HOMEkong2022'){if(pass!==null)toast('Wrong password','error');return;}
  }
  btn.disabled=true;btn.textContent='Uploading...';
  setStatus('transfer','Uploading '+uploadQueue.length+' file(s)...');
  const existing=new Set(items.map(i=>i.name));
  const dupes=uploadQueue.filter(f=>existing.has(f.relativePath.split('/')[0]));
  let dupeAction='replace';
  if(dupes.length){
    dupeAction=await showDupeChoice(dupes.length,'upload');
    if(dupeAction==='cancel'){btn.disabled=false;btn.textContent='Upload';return;}
  }
  let ok=0,fail=0,skipped=0,replaced=0;
  let folders=new Set(),files=0;
  const total=uploadQueue.length;
  btn.disabled=true;
  btn.style.cssText='position:relative;overflow:hidden;background:rgba(255,255,255,0.08);border:1px solid rgba(194,163,90,0.3);color:#F5F0E6;cursor:default;';
  btn.innerHTML='<span class="relative z-[1]" style="font-size:.8rem;">Uploading...</span><div id="upload-progress-bar" style="position:absolute;left:0;top:0;bottom:0;width:0%;background:#C2A35A;transition:width 0.3s ease;border-radius:inherit;"></div>';
  for(let i=0;i<uploadQueue.length;i++){
    const item=uploadQueue[i];item.status='uploading';
    const pct=Math.round(((i)/total)*100);
    const bar=document.getElementById('upload-progress-bar');if(bar)bar.style.width=pct+'%';
    const label=btn.querySelector('span');if(label)label.textContent=`Uploading ${i+1}/${total}...`;
    if(i%20===0)renderUploadList();
    try{
      const fileName=item.relativePath.split('/')[0];const isDupe=existing.has(fileName);
      if(isDupe&&dupeAction==='skip'){item.status='skipped';skipped++;continue;}
      const dest=uploadLocation||currentPath;
      let up=dest+(dest.endsWith('/')?'':'/')+item.relativePath;
      if(isDupe&&dupeAction==='rename'){const ext=item.relativePath.includes('.')?'.'+item.relativePath.split('.').pop():'';const base=item.relativePath.includes('.')?item.relativePath.slice(0,item.relativePath.lastIndexOf('.')):item.relativePath;up=dest+(dest.endsWith('/')?'':'/')+base+'_'+Date.now()+ext;}
      const parts=item.relativePath.split('/');
      if(parts.length>1){const dir=dest+(dest.endsWith('/')?'':'/')+parts.slice(0,-1).join('/');await api('/resources'+encodeURI(dir)+'/',{method:'POST',body:''});folders.add(parts[0]);}else{files++;}
      let status;
      if(item.file.size>CHUNK_THRESHOLD){
        // Large file: chunked upload bypasses Cloudflare's 200MB body cap.
        const overwrite=isDupe&&dupeAction==='replace';
        status=await uploadFileChunked(up,item.file,overwrite,i,total,btn);
        if(overwrite&&status>=200&&status<300){item.status='replaced';replaced++;continue;}
      }else{
        status=await uploadFileXHR(up,item.file,item.file.type||'application/octet-stream','POST');
        if(status===409&&dupeAction==='replace'){status=await uploadFileXHR(up,item.file,item.file.type||'application/octet-stream','PUT');if(status>=200&&status<300){item.status='replaced';replaced++;continue;}}
      }
      if(status>=200&&status<300){item.status='done';ok++;}
      else if(status===409){item.status='skipped';skipped++;}
      else{item.status='error';fail++;}
    }catch(e){item.status='error';fail++;}
  }
  const bar=document.getElementById('upload-progress-bar');if(bar)bar.style.width='100%';
  renderUploadList();
  let summaryParts=[];
  if(folders.size)summaryParts.push(folders.size+' folder'+(folders.size>1?'s':''));
  if(ok||files)summaryParts.push((ok||files)+' file'+((ok||files)>1?'s':''));
  let summary='Uploaded '+summaryParts.join(', ');
  if(replaced)summary+=` · ${replaced} replaced`;if(skipped)summary+=` · ${skipped} skipped`;if(fail)summary+=` · ${fail} failed`;
  btn.style.cssText='cursor:pointer;background:#C2A35A;color:#1a1306;font-weight:600;';btn.innerHTML=summary;btn.disabled=false;
  setStatus(fail?'red':'green',summary,fail?'Upload had '+fail+' failures':null);
  // Auto-refresh file list immediately
  treeCache={};navigate(currentPath);
  btn.onmouseenter=()=>{btn.innerHTML='✓ Done — Click to close';};btn.onmouseleave=()=>{btn.innerHTML=summary;};
  btn.onclick=()=>{btn.onmouseenter=null;btn.onmouseleave=null;btn.onclick=null;closeUpload();btn.textContent='Upload';btn.style.cssText='';};
}
function uploadFileXHR(path,file,contentType,method){
  return new Promise((resolve)=>{
    const xhr=new XMLHttpRequest();xhr.open(method,'/api/resources'+encodeURI(path));xhr.setRequestHeader('X-Auth',token);xhr.setRequestHeader('Content-Type',contentType);
    xhr.upload.onprogress=(e)=>{if(e.lengthComputable){const filePct=Math.round((e.loaded/e.total)*100);const label=document.querySelector('#upload-go span');if(label&&filePct<100)label.textContent=`Uploading... ${filePct}%`;}};
    xhr.onload=()=>resolve(xhr.status);xhr.onerror=()=>resolve(0);xhr.ontimeout=()=>resolve(0);xhr.timeout=600000;xhr.send(file);
  });
}
function showDupeChoice(count,context){
  // context: 'upload','move','paste' — adjusts wording
  const actionWord=context==='upload'?'upload':context==='move'?'move':'paste';
  return new Promise(resolve=>{
    const html=`<p class="text-sm mb-3">${count} item(s) already exist at the destination.</p>
      <button onclick="this.closest('.modal-overlay').classList.add('hidden');this.closest('.modal-overlay').classList.remove('flex');window._dupeResolve('replace')" class="w-full py-2.5 mb-2 rounded font-semibold text-sm cursor-pointer border border-warn text-warn bg-warn/10 hover:bg-warn/20 transition">Replace existing</button>
      <button onclick="this.closest('.modal-overlay').classList.add('hidden');this.closest('.modal-overlay').classList.remove('flex');window._dupeResolve('rename')" class="w-full py-2.5 mb-2 rounded font-semibold text-sm cursor-pointer border border-sky-400 text-sky-400 bg-sky-400/10 hover:bg-sky-400/20 transition">Keep both (auto-rename)</button>
      <button onclick="this.closest('.modal-overlay').classList.add('hidden');this.closest('.modal-overlay').classList.remove('flex');window._dupeResolve('skip')" class="w-full py-2.5 mb-2 rounded font-semibold text-sm cursor-pointer border border-cream-dim text-cream-dim bg-white/5 hover:bg-white/10 transition">Skip duplicates</button>
      <button onclick="this.closest('.modal-overlay').classList.add('hidden');this.closest('.modal-overlay').classList.remove('flex');window._dupeResolve('cancel')" class="w-full py-2.5 rounded font-semibold text-sm cursor-pointer border border-danger/40 text-danger bg-danger/10 hover:bg-danger/20 transition">Cancel</button>`;
    window._dupeResolve=resolve;
    document.getElementById('move-confirm-detail').innerHTML=html;
    document.getElementById('move-confirm-modal').querySelector('h2').textContent='Duplicates Found';
    document.getElementById('move-confirm-exec-btn').style.display='none';
    document.getElementById('move-confirm-cancel-btn').style.display='none';
    document.getElementById('move-confirm-modal').classList.remove('hidden');
    document.getElementById('move-confirm-modal').classList.add('flex');
  });
}

// Check destination for existing items and handle conflicts
// Returns: {action:'replace'|'rename'|'skip'|'cancel', existingNames:Set}
async function checkDuplicates(destFolder, names, context){
  try{
    const res=await api('/resources'+destFolder);
    if(!res.ok)return {action:'replace',existingNames:new Set()};
    const d=await res.json();
    const existingNames=new Set((d.items||[]).map(i=>i.name));
    const dupes=names.filter(n=>existingNames.has(n));
    if(!dupes.length)return {action:'replace',existingNames};
    const choice=await showDupeChoice(dupes.length,context);
    return {action:choice,existingNames};
  }catch(e){return {action:'replace',existingNames:new Set()};}
}

// Generate a renamed path to avoid conflict (_1, _2, _3 etc.)
function getRenamePath(destFolder,name,existingNames){
  const dot=name.lastIndexOf('.');
  const base=dot>0?name.slice(0,dot):name;
  const ext=dot>0?name.slice(dot):'';
  let n=1;
  let candidate;
  do {
    candidate=base+'_'+n+ext;
    n++;
  } while(existingNames&&existingNames.has(candidate));
  return destFolder+(destFolder.endsWith('/')?'':'/')+candidate;
}
