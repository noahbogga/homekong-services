// ===== UNDO SYSTEM =====
let undoStack = [];
let redoStack = [];
function pushUndo(type,actions){
  undoStack.push({type,actions,timestamp:Date.now()});
  if(undoStack.length>20)undoStack.shift();
  redoStack=[]; // clear redo on new action
  showUndoRedoBtn();
}
function showUndoRedoBtn(){
  const tbUndo=document.getElementById('tb-undo');
  const tbRedo=document.getElementById('tb-redo');
  if(tbUndo)tbUndo.style.display=undoStack.length?'':'none';
  if(tbRedo)tbRedo.style.display=redoStack.length?'':'none';
  updateToolbar();
}
async function undoLast(){
  if(!undoStack.length){toast('Nothing to undo','info');return;}
  const entry=undoStack.pop();
  showUndoRedoBtn();
  if(entry.type==='move'||entry.type==='cut'){
    toast('Undoing move...','info');let ok=0;
    for(const a of entry.actions){const r=await api('/resources'+encodeURI(a.to)+'?action=rename&destination='+encodeURIComponent(a.from),{method:'PATCH'});if(r.ok)ok++;}
    toast(ok?`Undone — ${ok} item(s) moved back`:'Undo failed','success');
  } else if(entry.type==='copy'){
    toast('Undoing copy...','info');let ok=0;
    for(const a of entry.actions){const r=await api('/resources'+encodeURI(a.to),{method:'DELETE'});if(r.ok)ok++;}
    toast(ok?`Undone — ${ok} copied item(s) removed`:'Undo failed','success');
  } else if(entry.type==='rename'){
    toast('Undoing rename...','info');let ok=0;
    for(const a of entry.actions){const r=await api('/resources'+encodeURI(a.to)+'?action=rename&destination='+encodeURIComponent(a.from),{method:'PATCH'});if(r.ok)ok++;}
    toast(ok?`Undone — ${ok} item(s) renamed back`:'Undo failed','success');
  } else if(entry.type==='duplicate'){
    toast('Undoing duplicate...','info');let ok=0;
    for(const a of entry.actions){const r=await api('/resources'+encodeURI(a.to),{method:'DELETE'});if(r.ok)ok++;}
    toast(ok?`Undone — ${ok} duplicate(s) removed`:'Undo failed','success');
  }
  redoStack.push(entry);showUndoRedoBtn();
  treeCache={};navigate(currentPath);
}
async function redoLast(){
  if(!redoStack.length){toast('Nothing to redo','info');return;}
  const entry=redoStack.pop();
  showUndoRedoBtn();
  if(entry.type==='move'||entry.type==='cut'){
    toast('Redoing move...','info');let ok=0;
    for(const a of entry.actions){const r=await api('/resources'+encodeURI(a.from)+'?action=rename&destination='+encodeURIComponent(a.to),{method:'PATCH'});if(r.ok)ok++;}
    toast(ok?`Redone — ${ok} item(s) moved`:'Redo failed','success');
  } else if(entry.type==='copy'){
    toast('Redoing copy...','info');let ok=0;
    for(const a of entry.actions){const r=await api('/resources'+encodeURI(a.from)+'?action=copy&destination='+encodeURIComponent(a.to),{method:'PATCH'});if(r.ok)ok++;}
    toast(ok?`Redone — ${ok} item(s) copied`:'Redo failed','success');
  } else if(entry.type==='rename'){
    toast('Redoing rename...','info');let ok=0;
    for(const a of entry.actions){const r=await api('/resources'+encodeURI(a.from)+'?action=rename&destination='+encodeURIComponent(a.to),{method:'PATCH'});if(r.ok)ok++;}
    toast(ok?`Redone — ${ok} item(s) renamed`:'Redo failed','success');
  } else if(entry.type==='duplicate'){
    toast('Redoing duplicate...','info');let ok=0;
    for(const a of entry.actions){const r=await api('/resources'+encodeURI(a.from)+'?action=copy&destination='+encodeURIComponent(a.to),{method:'PATCH'});if(r.ok)ok++;}
    toast(ok?`Redone — ${ok} duplicate(s) recreated`:'Redo failed','success');
  }
  undoStack.push(entry);showUndoRedoBtn();
  treeCache={};navigate(currentPath);
}

// ===== CLIPBOARD (Copy/Cut/Paste) =====
let clipboard = { items: [], mode: null, sourcePath: '' };

function copySelected(){
  if(selectedSet.size===0&&activeIdx>=0)selectedSet.add(activeIdx);
  if(selectedSet.size===0)return;
  clipboard={items:[...selectedSet].map(i=>({name:items[i].name,isDir:items[i].isDir,path:getItemPath(i)})),mode:'copy',sourcePath:currentPath};
  toast(`Copied ${clipboard.items.length} item(s)`,'success');updatePasteBtn();
}
function cutSelected(){
  if(selectedSet.size===0&&activeIdx>=0)selectedSet.add(activeIdx);
  if(selectedSet.size===0)return;
  clipboard={items:[...selectedSet].map(i=>({name:items[i].name,isDir:items[i].isDir,path:getItemPath(i)})),mode:'cut',sourcePath:currentPath};
  toast(`Cut ${clipboard.items.length} item(s)`,'info');updatePasteBtn();
}

async function handlePaste(){
  if(clipboard.items.length&&clipboard.mode){confirmPaste();return;}
  try{
    const clipItems=await navigator.clipboard.read();
    for(const item of clipItems){
      const imageType=item.types.find(t=>t.startsWith('image/'));
      if(imageType){
        const blob=await item.getType(imageType);
        const ext=imageType.split('/')[1]==='png'?'png':'jpg';
        const name='paste_'+Date.now()+'.'+ext;
        toast('Uploading pasted image...','info');
        const r=await api('/resources'+encodeURI(currentPath+(currentPath.endsWith('/')?'':'/')+name),{method:'POST',headers:{'X-Auth':token,'Content-Type':imageType},body:blob});
        if(r.ok){toast('Pasted image saved as '+name,'success');navigate(currentPath);}
        else toast('Upload failed','error');
        return;
      }
    }
    toast('Use Copy/Cut in file manager first, or drag files to upload','info');
  }catch(e){toast('Use Copy/Cut in file manager first, or drag files to upload','info');}
}

async function confirmPaste(){
  if(!clipboard.items.length||!clipboard.mode){toast('Nothing to paste','info');return;}
  const verb=clipboard.mode==='copy'?'Copy':'Move';
  const names=clipboard.items.map(i=>i.name);

  // Pre-fetch destination to detect dupes
  let existingNames=new Set();
  try{
    const res=await api('/resources'+currentPath);
    if(res.ok){const d=await res.json();existingNames=new Set((d.items||[]).map(i=>i.name));}
  }catch(e){}
  const dupes=names.filter(n=>existingNames.has(n));

  // Build unified modal
  let html=`<p class="mb-2 text-sm">${verb} ${names.length} item(s) here:</p>`;
  html+=clipboard.items.slice(0,8).map(i=>{
    const isDupe=existingNames.has(i.name);
    const dupeTag=isDupe?'<span class="ml-1 px-1 py-0.5 bg-warn/20 text-warn rounded text-[.5rem]">exists</span>':'';
    return `<p class="text-gold mb-0.5 text-xs flex items-center gap-1.5">${getConfirmItemIcon(i.name,i.isDir)} ${i.name}${dupeTag}</p>`;
  }).join('');
  if(names.length>8)html+=`<p class="text-cream-dim text-xs mt-1">...and ${names.length-8} more</p>`;
  html+=`<p class="text-[.7rem] text-cream-dim mt-2">From: ${clipboard.sourcePath}</p><p class="text-[.7rem] text-success">To: ${currentPath}</p>`;
  if(dupes.length)html+=`<p class="text-[.65rem] text-warn mt-1">⚠ ${dupes.length} item(s) already exist at destination</p>`;

  document.getElementById('move-confirm-detail').innerHTML=html;
  const modal=document.getElementById('move-confirm-modal');
  modal.querySelector('h2').textContent='📋 Confirm Paste';
  const execBtn=document.getElementById('move-confirm-exec-btn');
  const cancelBtn=document.getElementById('move-confirm-cancel-btn');
  cancelBtn.style.display='';

  // Store existingNames for execute
  window._pasteExistingNames=existingNames;

  if(dupes.length){
    execBtn.style.display='';execBtn.textContent=`Replace & ${verb}`;
    execBtn.setAttribute('onclick',"pasteWithDupeAction('replace')");
    let extraHtml=`<button class="w-full py-2.5 mt-2 bg-sky-400/10 border border-sky-400/40 text-sky-400 rounded font-semibold cursor-pointer text-sm hover:bg-sky-400/20 transition" onclick="pasteWithDupeAction('rename')">Keep both (auto-rename)</button>`;
    extraHtml+=`<button class="w-full py-2.5 mt-2 bg-white/5 border border-cream-dim/30 text-cream-dim rounded font-semibold cursor-pointer text-sm hover:bg-white/10 transition" onclick="pasteWithDupeAction('skip')">Skip duplicates</button>`;
    cancelBtn.insertAdjacentHTML('beforebegin',extraHtml);
  } else {
    execBtn.style.display='';execBtn.textContent=verb;
    execBtn.setAttribute('onclick',"pasteWithDupeAction('replace')");
  }
  modal.classList.remove('hidden');modal.classList.add('flex');
}

async function pasteWithDupeAction(dupeAction){
  const existingNames=window._pasteExistingNames||new Set();
  window._pasteExistingNames=null;
  const modal=document.getElementById('move-confirm-modal');
  modal.classList.add('hidden');modal.classList.remove('flex');
  // Clean up extra buttons
  modal.querySelectorAll('button:not(#move-confirm-exec-btn):not(#move-confirm-cancel-btn):not(.modal-close)').forEach(b=>b.remove());
  document.getElementById('move-confirm-exec-btn').setAttribute('onclick','executeMoveConfirm()');

  if(!clipboard.items.length||!clipboard.mode)return;
  const action=clipboard.mode==='copy'?'copy':'rename';
  let ok=0,fail=0,skipped=0;const undoActions=[];
  for(const item of clipboard.items){
    const src=clipboard.sourcePath+(clipboard.sourcePath.endsWith('/')?'':'/')+item.name;
    const isDupe=existingNames.has(item.name);
    if(isDupe&&dupeAction==='skip'){skipped++;continue;}
    let dest;
    if(isDupe&&dupeAction==='rename'){
      dest=getRenamePath(currentPath,item.name,existingNames);
    } else {
      dest=currentPath+(currentPath.endsWith('/')?'':'/')+item.name;
      if(isDupe&&dupeAction==='replace'){
        await api('/resources'+encodeURI(dest),{method:'DELETE'});
      }
    }
    if(src===dest){fail++;continue;}
    const r=await api('/resources'+encodeURI(src)+'?action='+action+'&destination='+encodeURIComponent(dest),{method:'PATCH'});
    if(r.ok){ok++;undoActions.push({from:src,to:dest});}else fail++;
  }
  if(ok)pushUndo(clipboard.mode==='copy'?'copy':'cut',undoActions);
  const verb=clipboard.mode==='copy'?'Pasted':'Moved';
  let msg=ok?`${verb} ${ok} item(s)`:'Paste failed';
  if(skipped)msg+=` · ${skipped} skipped`;
  toast(msg,fail?'error':'success');
  if(clipboard.mode==='cut')clipboard={items:[],mode:null,sourcePath:''};
  updatePasteBtn();treeCache={};selectedSet.clear();activeIdx=-1;multiSelectMode=false;navigate(currentPath);
}

function updatePasteBtn(){
  updateToolbar();
}
