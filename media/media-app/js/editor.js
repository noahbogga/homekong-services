// ===== IMAGE EDITOR — Clean rewrite =====
// Architecture: OriginalImage → AI Generate → Fabric Editor (annotations on top)
// Background = canvas.setBackgroundImage (never an object)
// Annotations = fabric objects (paths, text, shapes) — tracked by undo/redo

let editorCanvas = null;
let editorMode = 'select';
let editorOriginalUrl = '';
let editorFilePath = '';
let editorBrushColor = '#ff0000';
let editorBrushWidth = 3;
let editorTextColor = '#ffffff';
let editorFontSize = 24;
let editorCropRect = null;
let editorHistory = [];
let editorHistoryIdx = -1;
let editorDirty = false;
let editorInitialSave = true;
let editorLayerOriginal = null; // blob URL of original
let editorLayerAI = null;       // blob URL of AI result
let editorShowingOriginal = false;
let aiGenerating = false;
let aiAbortController = null;

// ===== OPEN / CLOSE =====
function openImageEditor() {
  if (!viewerFilePath) return;
  editorFilePath = viewerFilePath;
  editorOriginalUrl = '/api/raw' + encodeURI(viewerFilePath) + '?auth=' + token;
  editorDirty = false;
  editorInitialSave = true;
  editorLayerOriginal = null;
  editorLayerAI = null;
  editorShowingOriginal = false;

  document.getElementById('viewer-body').style.display = 'none';
  document.getElementById('editor-panel').classList.remove('hidden');
  document.getElementById('editor-panel').classList.add('flex');
  document.getElementById('viewer-edit').classList.add('hidden');
  document.getElementById('viewer-share').style.display = 'none';
  document.getElementById('viewer-header').querySelector('[onclick="downloadViewing()"]').style.display = 'none';
  _showAetherToggle();

  initEditorCanvas();
}

function closeImageEditor() {
  document.getElementById('editor-panel').classList.add('hidden');
  document.getElementById('editor-panel').classList.remove('flex');
  document.getElementById('viewer-body').style.display = '';
  document.getElementById('viewer-edit').classList.remove('hidden');
  document.getElementById('viewer-share').style.display = '';
  document.getElementById('viewer-header').querySelector('[onclick="downloadViewing()"]').style.display = '';
  _hideAetherToggle();

  if (editorCanvas) { editorCanvas.dispose(); editorCanvas = null; }
  editorHistory = []; editorHistoryIdx = -1; editorCropRect = null;
  editorDirty = false; editorLayerOriginal = null; editorLayerAI = null;
  _aiOverlayHide();
}

// ===== CLOSE CONFIRMATION =====
function _editorShowConfirm(title, bodyHtml, buttons) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center;';
    let btnHtml = buttons.map((b, i) => {
      const mt = i > 0 ? 'margin-top:8px;' : '';
      return `<button data-val="${b.val}" style="${mt}width:100%;padding:10px;border-radius:6px;font-weight:600;font-size:13px;cursor:pointer;border:1px solid ${b.border||'rgba(255,255,255,0.2)'};color:${b.color||'#F5F0E6'};background:${b.bg||'rgba(255,255,255,0.05)'};">${b.label}</button>`;
    }).join('');
    overlay.innerHTML = `<div style="background:#122050;border:1px solid rgba(194,163,90,0.5);border-radius:12px;padding:24px;width:90%;max-width:400px;">
      <h2 style="font-family:Cinzel,serif;font-size:14px;letter-spacing:0.08em;margin-bottom:12px;color:#F5F0E6;">${title}</h2>
      <div style="margin-bottom:12px;font-size:12px;color:#F5F0E6;">${bodyHtml}</div>
      ${btnHtml}
    </div>`;
    overlay.addEventListener('click', e => {
      const btn = e.target.closest('button[data-val]');
      if (btn) { overlay.remove(); resolve(btn.dataset.val); }
      if (e.target === overlay) { overlay.remove(); resolve('cancel'); }
    });
    document.body.appendChild(overlay);
  });
}

async function editorRequestClose() {
  if (aiGenerating) {
    const c = await _editorShowConfirm('AI in Progress',
      '<p style="color:rgba(245,240,230,0.6)">Cancel the generation?</p>',
      [{ val: 'yes', label: 'Cancel & Close', border:'rgba(231,76,60,0.5)', color:'#e74c3c', bg:'rgba(231,76,60,0.1)' },
       { val: 'no', label: 'Keep Waiting', border:'rgba(245,240,230,0.2)', color:'rgba(245,240,230,0.6)', bg:'rgba(255,255,255,0.03)' }]);
    if (c === 'yes') { editorAiCancel(); setTimeout(closeImageEditor, 200); }
    return;
  }
  if (!editorDirty) { closeImageEditor(); return; }
  const c = await _editorShowConfirm('Unsaved Changes',
    '<p style="color:rgba(245,240,230,0.6)">You have unsaved changes.</p>',
    [{ val: 'save', label: 'Save & Close', border:'rgba(39,174,96,0.5)', color:'#27ae60', bg:'rgba(39,174,96,0.12)' },
     { val: 'saveas', label: 'Save As & Close', border:'rgba(194,163,90,0.4)', color:'#C2A35A', bg:'rgba(194,163,90,0.08)' },
     { val: 'discard', label: 'Discard', border:'rgba(231,76,60,0.4)', color:'#e74c3c', bg:'rgba(231,76,60,0.08)' },
     { val: 'cancel', label: 'Cancel', border:'rgba(245,240,230,0.2)', color:'rgba(245,240,230,0.6)', bg:'rgba(255,255,255,0.03)' }]);
  if (c === 'save') { await editorSave(); closeImageEditor(); }
  else if (c === 'saveas') { await editorSaveAs(); closeImageEditor(); }
  else if (c === 'discard') { closeImageEditor(); }
}

function closeViewer() {
  if (editorCanvas && (editorDirty || aiGenerating)) { editorRequestClose(); return; }
  if (editorCanvas) closeImageEditor();
  document.getElementById('viewer').classList.add('hidden');
  document.getElementById('viewer').classList.remove('flex');
  if (monacoEditor) { monacoEditor.dispose(); monacoEditor = null; }
  viewerFilePath = '';
}

// ===== CANVAS INIT =====
function initEditorCanvas() {
  const container = document.getElementById('editor-canvas-wrap');
  const canvasEl = document.getElementById('editor-canvas');
  const w = container.clientWidth, h = container.clientHeight;
  canvasEl.width = w; canvasEl.height = h;

  // Create background img element BEHIND the canvas (not inside Fabric)
  let bgImg = document.getElementById('editor-bg-img');
  if (!bgImg) {
    bgImg = document.createElement('img');
    bgImg.id = 'editor-bg-img';
    bgImg.style.cssText = 'position:absolute;inset:0;margin:auto;max-width:calc(100% - 20px);max-height:calc(100% - 20px);object-fit:contain;pointer-events:none;z-index:0;';
    container.insertBefore(bgImg, container.firstChild);
  }
  bgImg.src = editorOriginalUrl;

  // Make canvas transparent so bg img shows through
  editorCanvas = new fabric.Canvas('editor-canvas', { backgroundColor: 'transparent', selection: true, isDrawingMode: false });

  // Cache original as blob URL once loaded
  editorLayerOriginal = null; editorLayerAI = null; editorShowingOriginal = false;
  bgImg.onload = function() {
    const tmp = document.createElement('canvas');
    tmp.width = bgImg.naturalWidth; tmp.height = bgImg.naturalHeight;
    tmp.getContext('2d').drawImage(bgImg, 0, 0);
    tmp.toBlob(blob => { editorLayerOriginal = URL.createObjectURL(blob); }, 'image/png');
    saveEditorState();
  };

  setEditorMode('select');
}

// Swap the background image (just changes the <img> src — instant, guaranteed)
function _setCanvasBg(imgEl) {
  // Not used in new architecture — kept for compat
}

function _loadBgFromUrl(url, cb) {
  const bgImg = document.getElementById('editor-bg-img');
  if (!bgImg) return;
  bgImg.onload = function() { if (cb) cb(); };
  bgImg.onerror = function() { toast('Failed to load image', 'error'); };
  bgImg.src = url;
}

// ===== AI GENERATION OVERLAY =====
// Covers the ENTIRE viewer (toolbar, canvas, AI panel, back button — everything)
function _aiOverlayShow() {
  let ov = document.getElementById('ai-gen-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'ai-gen-overlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(10,18,48,0.95);z-index:99990;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;';
    ov.innerHTML = `
      <button id="ai-gen-overlay-stop" style="position:absolute;top:12px;left:12px;padding:8px 16px;border:1px solid rgba(231,76,60,0.5);border-radius:6px;color:#e74c3c;background:rgba(231,76,60,0.08);font-size:12px;font-weight:600;cursor:pointer;">■ Stop</button>
      <img src="/assets/aether-bw.jpg" style="width:48px;height:48px;border-radius:10px;margin-bottom:8px;opacity:0.8;">
      <div style="font-size:18px;color:#C2A35A;font-weight:600;" id="ai-gen-overlay-text">Aether generating...</div>
      <div style="font-size:32px;color:#F5F0E6;font-weight:700;font-family:monospace;" id="ai-gen-overlay-timer">0s</div>
      <p style="font-size:11px;color:rgba(245,240,230,0.4);margin-top:8px;">Creating your image. Please wait.</p>
    `;
    document.body.appendChild(ov);
  }
  ov.style.display = 'flex';
  document.getElementById('ai-gen-overlay-stop').onclick = () => editorAiCancel();
}

function _aiOverlayHide() {
  const ov = document.getElementById('ai-gen-overlay');
  if (ov) ov.style.display = 'none';
}

function _aiOverlayTimer(seconds) {
  const el = document.getElementById('ai-gen-overlay-timer');
  if (el) el.textContent = seconds + 's';
}

// ===== AI GENERATE =====
function _aiBeforeUnload(e) { e.preventDefault(); e.returnValue = ''; }

async function editorAiGenerate() {
  const prompt = document.getElementById('ai-prompt-input').value.trim();
  if (!prompt) { toast('Enter a prompt', 'error'); return; }
  if (aiGenerating) return;

  aiGenerating = true;
  aiAbortController = new AbortController();

  // Show overlay (blocks canvas interaction)
  _aiOverlayShow();
  window.addEventListener('beforeunload', _aiBeforeUnload);

  // Update generate button
  const btn = document.getElementById('ai-generate-btn');
  btn.disabled = true; btn.textContent = 'Generating...';

  let elapsed = 0;
  const timer = setInterval(() => { elapsed++; _aiOverlayTimer(elapsed); btn.textContent = 'Generating... ' + elapsed + 's'; }, 1000);

  try {
    // Get current background image resized for API upload
    const bgImg = document.getElementById('editor-bg-img');
    let imageData = null;
    if (bgImg && bgImg.src && bgImg.naturalWidth) {
      const MAX = 2048;
      let w = bgImg.naturalWidth, h = bgImg.naturalHeight;
      if (w > MAX || h > MAX) { const s = Math.min(MAX/w, MAX/h); w = Math.round(w*s); h = Math.round(h*s); }
      const tmp = document.createElement('canvas');
      tmp.width = w; tmp.height = h;
      tmp.getContext('2d').drawImage(bgImg, 0, 0, w, h);
      imageData = tmp.toDataURL('image/png');
    }

    const payload = { prompt };
    if (imageData) payload.image = imageData;

    // Step 1: Submit job (returns immediately with jobId)
    const submitRes = await fetch('/search-api/ai-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: aiAbortController.signal,
    });
    if (!submitRes.ok) { toast('Aether error: HTTP ' + submitRes.status, 'error'); return; }
    const submitData = await submitRes.json();
    if (submitData.error) { toast('Aether error: ' + submitData.error, 'error'); return; }
    const jobId = submitData.jobId;
    if (!jobId) { toast('Aether error: no job ID returned', 'error'); return; }

    // Step 2: Poll for result (no Cloudflare timeout — each poll is tiny)
    while (true) {
      await new Promise(r => setTimeout(r, 2000));
      if (aiAbortController.signal.aborted) throw new DOMException('', 'AbortError');

      const pollRes = await fetch('/search-api/ai-image?id=' + jobId, { signal: aiAbortController.signal });
      if (!pollRes.ok) { toast('Aether poll error', 'error'); return; }
      const job = await pollRes.json();

      if (job.status === 'done') {
        const clean = (job.b64 || '').replace(/[\r\n\s]/g, '');
        let blobUrl;
        if (clean.startsWith('http')) { blobUrl = clean; }
        else { const raw = atob(clean); const arr = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i); blobUrl = URL.createObjectURL(new Blob([arr], { type: 'image/png' })); }
        editorLayerAI = blobUrl;

        let openBtn = document.getElementById('ai-open-tab-btn');
        if (!openBtn) { openBtn = document.createElement('button'); openBtn.id = 'ai-open-tab-btn'; openBtn.style.cssText = 'width:100%;padding:6px;margin-top:6px;border:1px solid rgba(52,152,219,0.4);border-radius:6px;color:#3498db;background:rgba(52,152,219,0.08);font-size:11px;cursor:pointer;'; document.getElementById('ai-generate-btn').after(openBtn); }
        openBtn.textContent = 'Open result in new tab'; openBtn.onclick = () => window.open(blobUrl, '_blank'); openBtn.style.display = '';

        _loadBgFromUrl(blobUrl, () => {
          // AI gives a new image — wipe undo history, fresh start
          editorCanvas.getObjects().slice().forEach(o => editorCanvas.remove(o));
          editorCanvas.renderAll();
          editorHistory = []; editorHistoryIdx = -1; editorInitialSave = true;
          editorDirty = true;
          saveEditorState();
          toast('Aether image applied', 'success');
        });
        return;
      } else if (job.status === 'error') {
        toast('Aether error: ' + (job.error || 'unknown'), 'error');
        return;
      }
      // pending — keep polling
    }

  } catch (e) {
    if (e.name === 'AbortError') toast('Aether cancelled', 'info');
    else toast('Aether error: ' + e.message, 'error');
  } finally {
    clearInterval(timer);
    aiGenerating = false;
    aiAbortController = null;
    btn.disabled = false; btn.textContent = 'Generate';
    _aiOverlayHide();
    window.removeEventListener('beforeunload', _aiBeforeUnload);
  }
}

function editorAiCancel() {
  if (aiAbortController) { aiAbortController.abort(); }
}

// ===== REVERT TO ORIGINAL =====
async function editorRevertOriginal() {
  if (!editorLayerOriginal) return;
  const c = await _editorShowConfirm('Revert to Original',
    '<p style="color:rgba(245,240,230,0.6)">This will discard ALL changes (edits + AI) and reload the original file.</p><p style="color:#e74c3c;margin-top:8px;">You will lose all progress.</p>',
    [{ val: 'yes', label: 'Revert to Original', border:'rgba(231,76,60,0.5)', color:'#e74c3c', bg:'rgba(231,76,60,0.1)' },
     { val: 'cancel', label: 'Cancel', border:'rgba(245,240,230,0.2)', color:'rgba(245,240,230,0.6)', bg:'rgba(255,255,255,0.03)' }]);
  if (c !== 'yes') return;
  // Wipe annotations
  editorCanvas.getObjects().slice().forEach(o => editorCanvas.remove(o));
  editorCanvas.renderAll();
  // Reset background to original
  editorLayerAI = null;
  _loadBgFromUrl(editorLayerOriginal, () => {
    // Reset undo/redo
    editorHistory = []; editorHistoryIdx = -1; editorInitialSave = true;
    editorDirty = false;
    saveEditorState();
    toast('Reverted to original', 'success');
  });
}

// ===== UNDO/REDO (annotations only) =====
function saveEditorState() {
  if (!editorCanvas) return;
  if (editorInitialSave) { editorInitialSave = false; } else { editorDirty = true; }
  const objs = editorCanvas.toJSON().objects || [];
  editorHistory = editorHistory.slice(0, editorHistoryIdx + 1);
  editorHistory.push(JSON.stringify(objs));
  editorHistoryIdx = editorHistory.length - 1;
  if (editorHistory.length > 30) { editorHistory.shift(); editorHistoryIdx--; }
}

function editorUndo() {
  if (editorHistoryIdx <= 0) return;
  editorHistoryIdx--;
  _restoreObjects(editorHistory[editorHistoryIdx]);
}

function editorRedo() {
  if (editorHistoryIdx >= editorHistory.length - 1) return;
  editorHistoryIdx++;
  _restoreObjects(editorHistory[editorHistoryIdx]);
}

function _restoreObjects(json) {
  editorCanvas.getObjects().slice().forEach(o => editorCanvas.remove(o));
  fabric.util.enlivenObjects(JSON.parse(json), objs => {
    objs.forEach(o => editorCanvas.add(o));
    editorCanvas.renderAll();
  });
}

// ===== EDITOR TOOLS =====
function setEditorMode(mode) {
  editorMode = mode;
  if (!editorCanvas) return;
  editorCanvas.isDrawingMode = false;
  editorCanvas.selection = true;
  editorCanvas.defaultCursor = 'default';
  editorCanvas.off('mouse:down'); editorCanvas.off('mouse:move'); editorCanvas.off('mouse:up');
  if (mode !== 'crop' && editorCropRect) { editorCanvas.remove(editorCropRect); editorCropRect = null; editorCanvas.renderAll(); }

  document.querySelectorAll('.editor-tool-btn').forEach(btn => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('!border-gold', active);
    btn.classList.toggle('!bg-gold/20', active);
    btn.classList.toggle('!text-gold', active);
  });
  const cropBtn = document.getElementById('editor-crop-apply');
  if (cropBtn) cropBtn.style.display = mode === 'crop' ? '' : 'none';

  switch (mode) {
    case 'draw':
      editorCanvas.isDrawingMode = true;
      editorCanvas.freeDrawingBrush = new fabric.PencilBrush(editorCanvas);
      editorCanvas.freeDrawingBrush.color = editorBrushColor;
      editorCanvas.freeDrawingBrush.width = editorBrushWidth;
      editorCanvas.on('path:created', () => saveEditorState());
      break;
    case 'highlight':
      editorCanvas.isDrawingMode = true;
      editorCanvas.freeDrawingBrush = new fabric.PencilBrush(editorCanvas);
      editorCanvas.freeDrawingBrush.color = 'rgba(255,255,0,0.35)';
      editorCanvas.freeDrawingBrush.width = 20;
      editorCanvas.on('path:created', () => saveEditorState());
      break;
    case 'text':
      editorCanvas.defaultCursor = 'text'; editorCanvas.selection = false;
      editorCanvas.on('mouse:down', opt => {
        if (opt.target) return;
        const p = editorCanvas.getPointer(opt.e);
        const t = new fabric.IText('Type here', { left:p.x, top:p.y, fontFamily:'Inter,sans-serif', fontSize:editorFontSize, fill:editorTextColor, shadow:'1px 1px 3px rgba(0,0,0,0.5)' });
        editorCanvas.add(t); editorCanvas.setActiveObject(t); t.enterEditing(); t.selectAll(); saveEditorState();
      });
      break;
    case 'eraser':
      editorCanvas.defaultCursor = 'crosshair'; editorCanvas.selection = false;
      editorCanvas.on('mouse:down', opt => { if (opt.target) { editorCanvas.remove(opt.target); editorCanvas.renderAll(); saveEditorState(); } });
      break;
    case 'crop':
      editorCanvas.selection = false; editorCanvas.defaultCursor = 'crosshair';
      let sx, sy, down = false;
      editorCanvas.on('mouse:down', opt => {
        if (editorCropRect) { editorCanvas.remove(editorCropRect); editorCropRect = null; }
        down = true; const p = editorCanvas.getPointer(opt.e); sx = p.x; sy = p.y;
        editorCropRect = new fabric.Rect({ left:sx, top:sy, width:0, height:0, fill:'rgba(194,163,90,0.15)', stroke:'#C2A35A', strokeWidth:2, strokeDashArray:[5,5], selectable:true });
        editorCanvas.add(editorCropRect);
      });
      editorCanvas.on('mouse:move', opt => { if (!down||!editorCropRect) return; const p=editorCanvas.getPointer(opt.e); editorCropRect.set({width:Math.abs(p.x-sx),height:Math.abs(p.y-sy),left:Math.min(p.x,sx),top:Math.min(p.y,sy)}); editorCanvas.renderAll(); });
      editorCanvas.on('mouse:up', () => { down = false; });
      break;
  }
}

function editorSetColor(c) { editorBrushColor=c; editorTextColor=c; if(editorCanvas&&editorCanvas.isDrawingMode&&editorMode==='draw')editorCanvas.freeDrawingBrush.color=c; const o=editorCanvas?.getActiveObject(); if(o&&o.type==='i-text'){o.set('fill',c);editorCanvas.renderAll();} }
function editorSetBrushSize(s) { editorBrushWidth=parseInt(s); if(editorCanvas&&editorCanvas.isDrawingMode)editorCanvas.freeDrawingBrush.width=editorBrushWidth; }
function editorSetFontSize(s) { editorFontSize=parseInt(s); const o=editorCanvas?.getActiveObject(); if(o&&o.type==='i-text'){o.set('fontSize',editorFontSize);editorCanvas.renderAll();} }

function editorApplyCrop() {
  if (!editorCropRect||!editorCanvas) return;
  const r=editorCropRect, l=r.left, t=r.top, w=r.width*r.scaleX, h=r.height*r.scaleY;
  editorCanvas.remove(editorCropRect); editorCropRect=null;
  const dataUrl=editorCanvas.toDataURL({left:l,top:t,width:w,height:h,format:'png',quality:1});
  editorCanvas.getObjects().slice().forEach(o=>editorCanvas.remove(o));
  const img=new Image(); img.onload=function(){_setCanvasBg(img);editorLayerOriginal=URL.createObjectURL(_dataUrlToBlob(dataUrl));editorLayerAI=null;editorDirty=true;saveEditorState();toast('Crop applied','success');};
  img.src=dataUrl; setEditorMode('select');
}

function editorAddShape(type) {
  if(!editorCanvas)return;
  const cx=editorCanvas.width/2, cy=editorCanvas.height/2;
  let s;
  if(type==='rect')s=new fabric.Rect({left:cx,top:cy,originX:'center',originY:'center',width:150,height:100,fill:'rgba(194,163,90,0.3)',stroke:'#C2A35A',strokeWidth:2});
  else if(type==='circle')s=new fabric.Circle({left:cx,top:cy,originX:'center',originY:'center',radius:60,fill:'rgba(194,163,90,0.3)',stroke:'#C2A35A',strokeWidth:2});
  else if(type==='arrow')s=new fabric.Line([cx-80,cy,cx+80,cy],{stroke:editorBrushColor,strokeWidth:3,selectable:true});
  if(s){editorCanvas.add(s);editorCanvas.setActiveObject(s);editorCanvas.renderAll();saveEditorState();}
}

function editorDeleteSelected() { if(!editorCanvas)return; const o=editorCanvas.getActiveObject(); if(o){editorCanvas.remove(o);editorCanvas.renderAll();saveEditorState();} }

function editorUpscale2x() {
  if(!editorCanvas)return; toast('Upscaling 2x...','info');
  const dataUrl=editorCanvas.toDataURL({format:'png',quality:1,multiplier:2});
  editorCanvas.getObjects().slice().forEach(o=>editorCanvas.remove(o));
  const img=new Image(); img.onload=function(){_setCanvasBg(img);editorLayerOriginal=URL.createObjectURL(_dataUrlToBlob(dataUrl));editorLayerAI=null;editorDirty=true;saveEditorState();toast('Upscaled to '+img.naturalWidth+'x'+img.naturalHeight,'success');};
  img.src=dataUrl;
}

// ===== SAVE =====
// Composite: background img + canvas annotations → single image
function _getCompositeDataUrl(format, quality) {
  const bgImg = document.getElementById('editor-bg-img');
  const canvas = editorCanvas;
  if (!bgImg || !canvas) return null;

  // Create offscreen canvas at background's native resolution
  const out = document.createElement('canvas');
  out.width = bgImg.naturalWidth; out.height = bgImg.naturalHeight;
  const ctx = out.getContext('2d');

  // Draw background
  ctx.drawImage(bgImg, 0, 0, out.width, out.height);

  // Draw Fabric annotations on top (scaled from canvas coords to image coords)
  const fabricEl = canvas.getElement();
  const scaleX = out.width / fabricEl.width;
  const scaleY = out.height / fabricEl.height;
  ctx.scale(scaleX, scaleY);
  // Render fabric objects onto our context
  const annotationDataUrl = canvas.toDataURL({ format: 'png', quality: 1 });
  // Use sync approach: draw fabric canvas directly
  ctx.setTransform(1, 0, 0, 1, 0, 0); // reset
  const tmpImg = new Image();
  // We need to do this synchronously-ish, so use the canvas element directly
  ctx.drawImage(fabricEl, 0, 0, out.width, out.height);

  return out.toDataURL('image/' + (format || 'png'), quality || 0.92);
}

async function editorSave() {
  if(!editorCanvas||!editorFilePath)return;
  const name=editorFilePath.split('/').pop();
  const c=await _editorShowConfirm('Confirm Save',
    `<p>Overwrite <span style="color:#C2A35A">${name}</span>?</p><p style="color:rgba(245,240,230,0.5);margin-top:6px;">Cannot be reverted.</p>`,
    [{val:'yes',label:'Overwrite',border:'rgba(230,126,34,0.5)',color:'#e67e22',bg:'rgba(230,126,34,0.12)'},
     {val:'cancel',label:'Cancel',border:'rgba(245,240,230,0.2)',color:'rgba(245,240,230,0.6)',bg:'rgba(255,255,255,0.03)'}]);
  if(c!=='yes')return;
  const dataUrl = _getCompositeDataUrl('png', 0.92);
  const blob = await(await fetch(dataUrl)).blob();
  toast('Saving...','info');
  const r=await api('/resources'+encodeURI(editorFilePath)+'?override=true',{method:'PUT',body:blob});
  if(r.ok){
    editorDirty=false;toast('Saved ✓','success');
    const img=document.getElementById('viewer-body').querySelector('img');if(img)img.src=editorOriginalUrl+'&t='+Date.now();
    // Flash save button green
    const saveBtn=document.querySelector('#editor-panel [onclick="editorSave()"]');
    if(saveBtn){saveBtn.style.cssText='border-color:#27ae60;color:#27ae60;background:rgba(39,174,96,0.15);';saveBtn.textContent='✓ Saved';setTimeout(()=>{saveBtn.style.cssText='';saveBtn.textContent='💾 Save';},3000);}
  }
  else toast('Save failed: '+r.status,'error');
}

async function editorSaveAs() {
  if(!editorCanvas||!editorFilePath)return;
  const cur=editorFilePath.split('/').pop(), dot=cur.lastIndexOf('.'), base=dot>0?cur.slice(0,dot):cur;
  const parentDir=editorFilePath.substring(0,editorFilePath.lastIndexOf('/'));
  const result=await new Promise(resolve=>{
    const ov=document.createElement('div');
    ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center;';
    ov.innerHTML=`<div style="background:#122050;border:1px solid rgba(194,163,90,0.5);border-radius:12px;padding:24px;width:90%;max-width:440px;font-family:Inter,sans-serif;">
      <h2 style="font-family:Cinzel,serif;font-size:14px;letter-spacing:0.08em;margin-bottom:16px;color:#F5F0E6;">Save As</h2>
      <div style="margin-bottom:12px;"><label style="display:block;font-size:10px;text-transform:uppercase;letter-spacing:0.12em;color:rgba(245,240,230,0.5);margin-bottom:4px;">Filename</label><input id="_sa_n" type="text" value="${base}_edited" style="width:100%;padding:8px 12px;background:rgba(255,255,255,0.06);border:1px solid rgba(194,163,90,0.25);border-radius:4px;color:#F5F0E6;font-size:13px;outline:none;"></div>
      <div style="margin-bottom:12px;"><label style="display:block;font-size:10px;text-transform:uppercase;letter-spacing:0.12em;color:rgba(245,240,230,0.5);margin-bottom:4px;">Format</label><select id="_sa_f" style="width:100%;padding:8px 12px;background:#0C1838;border:1px solid rgba(194,163,90,0.25);border-radius:4px;color:#F5F0E6;font-size:13px;outline:none;"><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option></select></div>
      <div style="margin-bottom:16px;"><label style="display:block;font-size:10px;text-transform:uppercase;letter-spacing:0.12em;color:rgba(245,240,230,0.5);margin-bottom:4px;">Location</label><div style="display:flex;gap:6px;align-items:center;"><div id="_sa_p" style="flex:1;padding:8px 12px;background:rgba(255,255,255,0.03);border:1px solid rgba(194,163,90,0.15);border-radius:4px;color:rgba(245,240,230,0.6);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${parentDir}</div><button id="_sa_b" style="padding:8px;background:rgba(255,255,255,0.06);border:1px solid rgba(194,163,90,0.2);border-radius:4px;font-size:10px;color:#C2A35A;cursor:pointer;">📂</button></div></div>
      <div style="display:flex;gap:8px;"><button data-val="save" style="flex:1;padding:10px;background:rgba(194,163,90,0.15);border:1px solid rgba(194,163,90,0.4);border-radius:6px;color:#C2A35A;font-weight:600;font-size:13px;cursor:pointer;">Save</button><button data-val="cancel" style="flex:1;padding:10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);border-radius:6px;color:rgba(245,240,230,0.6);font-weight:600;font-size:13px;cursor:pointer;">Cancel</button></div></div>`;
    let sp=parentDir;
    ov.querySelector('#_sa_b').addEventListener('click',()=>{moveBrowsePath=sp;document.getElementById('move-modal').classList.remove('hidden');document.getElementById('move-modal').classList.add('flex');const orig=window.confirmMove;window.confirmMove=function(){sp=moveBrowsePath;ov.querySelector('#_sa_p').textContent=sp;document.getElementById('move-modal').classList.add('hidden');document.getElementById('move-modal').classList.remove('flex');window.confirmMove=orig;const mb=document.querySelector('#move-modal button[onclick="confirmMove()"]');if(mb)mb.textContent='Move Here';};const mb=document.querySelector('#move-modal button[onclick="confirmMove()"]');if(mb)mb.textContent='Select';renderMoveFolders();});
    ov.addEventListener('click',e=>{const b=e.target.closest('button[data-val]');if(b){if(b.dataset.val==='save'){const n=ov.querySelector('#_sa_n').value.trim(),f=ov.querySelector('#_sa_f').value;if(!n){toast('Enter name','error');return;}ov.remove();resolve({name:n,format:f,path:sp});}else{ov.remove();resolve(null);}}if(e.target===ov){ov.remove();resolve(null);}});
    ov.querySelector('#_sa_n').addEventListener('keydown',e=>{if(e.key==='Enter')ov.querySelector('[data-val="save"]').click();});
    document.body.appendChild(ov);setTimeout(()=>{ov.querySelector('#_sa_n').focus();ov.querySelector('#_sa_n').select();},50);
  });
  if(!result)return;
  const ext='.'+result.format, fullName=result.name.includes('.')?result.name:result.name+ext;
  const newPath=result.path+(result.path.endsWith('/')?'':'/')+fullName;
  const q=result.format==='png'?1:0.88;
  const blob=await(await fetch(_getCompositeDataUrl(result.format,q))).blob();
  toast('Saving as '+fullName+'...','info');
  const r=await api('/resources'+encodeURI(newPath),{method:'POST',body:blob});
  if(r.ok){
    editorDirty=false;toast('Saved as '+fullName+' ✓','success');
    // Flash save-as button green
    const saBtn=document.querySelector('#editor-panel [onclick="editorSaveAs()"]');
    if(saBtn){saBtn.style.cssText='border-color:#27ae60;color:#27ae60;background:rgba(39,174,96,0.15);';saBtn.textContent='✓ Saved';setTimeout(()=>{saBtn.style.cssText='';saBtn.textContent='Save As';},3000);}
  }
  else toast('Save failed: '+r.status,'error');
}

// ===== AI PRESETS =====
function editorAiPreset(p) {
  const m={'reimagine':'Recreate this image with improved composition, lighting, and detail while keeping the same subject','style-photo':'Transform into a professional photograph with studio lighting and sharp focus','style-art':'Reinterpret as a stylized digital artwork with painterly textures','extend':'Extend and fill the edges of this image naturally, expanding the scene'};
  document.getElementById('ai-prompt-input').value=m[p]||p;
}

// ===== HELPERS =====
function _dataUrlToBlob(d){const p=d.split(','),m=p[0].match(/:(.*?);/)[1],b=atob(p[1]),a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return new Blob([a],{type:m});}


