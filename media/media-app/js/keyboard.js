// ===== KEYBOARD SHORTCUTS =====
document.addEventListener('keydown',e=>{
  const ctrl=e.ctrlKey||e.metaKey;
  const shift=e.shiftKey;
  const key=e.key.toLowerCase();
  const inInput=document.activeElement.tagName==='INPUT'||document.activeElement.tagName==='TEXTAREA';
  const inViewer=document.getElementById('viewer').classList.contains('flex');
  const inEditor=inViewer&&monacoEditor;

  if(e.key==='Escape'){
    if(inViewer){closeViewer();return;}
    document.querySelectorAll('.modal-overlay').forEach(m=>{m.classList.add('hidden');m.classList.remove('flex');});
    return;
  }
  if(!token)return;

  // Editor shortcuts (let Monaco handle everything else)
  if(inEditor){
    if(ctrl&&!shift&&key==='s'){e.preventDefault();e.stopPropagation();saveFile();return;}
    if(ctrl&&shift&&key==='s'){e.preventDefault();e.stopPropagation();saveFileAs();return;}
    return;
  }

  // Search (override browser Ctrl+F / Cmd+F)
  if(ctrl&&key==='f'){e.preventDefault();e.stopPropagation();openSearch();return;}

  // Skip file shortcuts if typing in an input
  if(inInput)return;

  // === SHIFT COMBOS FIRST (must check before non-shift versions) ===
  if(ctrl&&shift&&key==='z'){e.preventDefault();e.stopPropagation();redoLast();return;}
  if(ctrl&&shift&&key==='n'){e.preventDefault();e.stopPropagation();openCreateNewModal();return;}
  if(ctrl&&shift&&key==='s'){e.preventDefault();e.stopPropagation();return;} // no-op outside editor

  // === CTRL COMBOS ===
  if(ctrl&&key==='c'){e.preventDefault();e.stopPropagation();copySelected();return;}
  if(ctrl&&key==='x'){e.preventDefault();e.stopPropagation();cutSelected();return;}
  if(ctrl&&key==='v'){e.preventDefault();e.stopPropagation();handlePaste();return;}
  if(ctrl&&key==='a'){e.preventDefault();e.stopPropagation();selectAll();return;}
  if(ctrl&&key==='z'){e.preventDefault();e.stopPropagation();undoLast();return;}
  if(ctrl&&key==='n'){e.preventDefault();e.stopPropagation();openCreateNewModal();return;}
  if(ctrl&&key==='u'){e.preventDefault();e.stopPropagation();openUploadModal();return;}
  if(ctrl&&key==='d'){e.preventDefault();e.stopPropagation();duplicateSelected();return;}
  if(ctrl&&key==='s'){e.preventDefault();e.stopPropagation();return;} // prevent save-page outside editor

  // === NON-CTRL KEYS ===
  if(e.key==='F2'&&selectedSet.size>0){e.preventDefault();renameSelected();return;}
  if(e.key==='F5'){e.preventDefault();navigate(currentPath);return;}
  if(e.key==='Delete'||(e.key==='Backspace'&&selectedSet.size>0)){e.preventDefault();deleteSelected();return;}
  if(e.key==='Enter'&&activeIdx>=0){e.preventDefault();handleDblClick(activeIdx);return;}
  if(e.key==='ArrowDown'&&items.length){e.preventDefault();navigateItem(1);return;}
  if(e.key==='ArrowUp'&&items.length){e.preventDefault();navigateItem(-1);return;}
  if(e.key==='Backspace'&&selectedSet.size===0){e.preventDefault();navigateUp();return;}
},{capture:true});

function navigateItem(dir){
  let next=activeIdx+dir;
  if(next<0)next=0;if(next>=items.length)next=items.length-1;
  selectedSet.clear();selectedSet.add(next);activeIdx=next;renderFiles();
  const el=document.querySelector(`[data-idx="${next}"]`);if(el)el.scrollIntoView({block:'nearest'});
}

// Type-to-find (like Windows Explorer) — press letters to jump to matching filename
let _typeSearchBuffer = '';
let _typeSearchTimer = null;
let _typeSearchLastIdx = -1;

document.addEventListener('keydown', e => {
  // Only when in file browser (not viewer, not modal, not input)
  if (document.getElementById('viewer').classList.contains('flex')) return;
  if (document.querySelector('.modal-overlay:not(.hidden)')) return;
  if (document.getElementById('ai-panel')?.style.display === 'flex') return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.length !== 1) return; // only single characters
  if (!items.length) return;

  e.preventDefault();
  _typeSearchBuffer += e.key.toLowerCase();
  clearTimeout(_typeSearchTimer);
  _typeSearchTimer = setTimeout(() => { _typeSearchBuffer = ''; _typeSearchLastIdx = -1; }, 800);

  // Find matching item — folders first, then files, sorted naturally
  const sorted = items.map((item, i) => ({ item, i }));
  let found = -1;

  if (_typeSearchBuffer.length === 1 && _typeSearchBuffer === _typeSearchBuffer[0].repeat(_typeSearchBuffer.length)) {
    // Single repeated char (e.g. "ppp") — cycle through items starting with that letter
    const char = _typeSearchBuffer[0];
    const matches = sorted.filter(s => s.item.name.toLowerCase().startsWith(char));
    if (matches.length) {
      // Find next match after current
      const currentMatchIdx = matches.findIndex(m => m.i > _typeSearchLastIdx);
      found = currentMatchIdx >= 0 ? matches[currentMatchIdx].i : matches[0].i;
    }
  } else {
    // Multi-char — find first item starting with the buffer
    const match = sorted.find(s => s.item.name.toLowerCase().startsWith(_typeSearchBuffer));
    if (match) found = match.i;
  }

  if (found >= 0) {
    _typeSearchLastIdx = found;
    selectedSet.clear(); selectedSet.add(found); activeIdx = found;
    renderFiles();
    const el = document.querySelector(`[data-idx="${found}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }
});

async function saveFileAs(){
  if(!monacoEditor||!viewerFilePath)return;
  const currentName=viewerFilePath.split('/').pop();
  const newName=await showPromptModal('Save As (new filename):',currentName);
  if(!newName||newName===currentName){if(newName===currentName)saveFile();return;}
  const parentDir=viewerFilePath.substring(0,viewerFilePath.lastIndexOf('/'));
  const newPath=parentDir+'/'+newName;
  const content=monacoEditor.getValue();const blob=new Blob([content],{type:'text/plain'});
  toast('Saving as '+newName+'...','info');
  try{
    const r=await api('/resources'+encodeURI(newPath),{method:'POST',body:blob});
    if(r.ok||r.status===200||r.status===204){toast('Saved as '+newName+' ✓','success');viewerFilePath=newPath;document.getElementById('viewer-filename').textContent=newName;}
    else{toast('Save As failed: '+r.status,'error');}
  }catch(e){toast('Save As error','error');}
}

function selectAll(){items.forEach((_,i)=>selectedSet.add(i));multiSelectMode=true;activeIdx=items.length-1;renderFiles();}

// ===== LASSO SELECTION (Desktop only) =====
let lassoActive=false;
let lassoStart={x:0,y:0};
let lassoBounds=null; // constrain lasso to file-list area

(function initLasso(){
  const fileList=document.getElementById('file-list');

  fileList.addEventListener('mousedown',e=>{
    if(window.innerWidth<768||('ontouchstart' in window))return;
    if(e.button!==0)return;
    if(e.target.closest('.file-item')||e.target.closest('.act-btn')||e.target.tagName==='BUTTON')return;
    lassoActive=true;
    lassoStart={x:e.clientX,y:e.clientY};
    lassoBounds=fileList.getBoundingClientRect();
    const lasso=document.getElementById('lasso-rect');
    lasso.style.left=e.clientX+'px';lasso.style.top=e.clientY+'px';
    lasso.style.width='0';lasso.style.height='0';
    lasso.style.display='block';
    // Prevent text selection during lasso
    document.body.classList.add('lasso-active');
    if(!e.ctrlKey&&!e.metaKey){selectedSet.clear();activeIdx=-1;}
    e.preventDefault();
  });

  document.addEventListener('mousemove',e=>{
    if(!lassoActive)return;
    e.preventDefault();
    const lasso=document.getElementById('lasso-rect');
    // Clamp cursor position to file-list bounds
    const cx=Math.max(lassoBounds.left,Math.min(e.clientX,lassoBounds.right));
    const cy=Math.max(lassoBounds.top,Math.min(e.clientY,lassoBounds.bottom));
    const x1=Math.min(cx,lassoStart.x),y1=Math.min(cy,lassoStart.y);
    const x2=Math.max(cx,lassoStart.x),y2=Math.max(cy,lassoStart.y);
    lasso.style.left=x1+'px';lasso.style.top=y1+'px';
    lasso.style.width=(x2-x1)+'px';lasso.style.height=(y2-y1)+'px';
    const lassoRect={left:x1,top:y1,right:x2,bottom:y2};
    // Only select .file-item elements inside #file-list
    fileList.querySelectorAll('.file-item').forEach(el=>{
      const r=el.getBoundingClientRect();
      const overlaps=r.left<lassoRect.right&&r.right>lassoRect.left&&r.top<lassoRect.bottom&&r.bottom>lassoRect.top;
      const idx=parseInt(el.dataset.idx);
      if(isNaN(idx))return;
      if(overlaps)selectedSet.add(idx);
      else if(!e.ctrlKey&&!e.metaKey)selectedSet.delete(idx);
    });
    updateToolbar();
  });

  document.addEventListener('mouseup',e=>{
    if(!lassoActive)return;
    lassoActive=false;
    lassoBounds=null;
    document.getElementById('lasso-rect').style.display='none';
    // Restore text selection
    document.body.classList.remove('lasso-active');
    updateToolbar();
    if(selectedSet.size>0){activeIdx=[...selectedSet].pop();renderFiles();}
  });
})();
