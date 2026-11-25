(function() {
  var DIRECT_HOST = 'https://direct.homekong.cc';
  var directToken = '';

  // Get a token from the direct (noauth) server
  function getDirectToken(callback) {
    if (directToken) { callback(directToken); return; }
    var xhr = new XMLHttpRequest();
    xhr.open('POST', DIRECT_HOST + '/api/login', true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = function() {
      if (xhr.status === 200) {
        directToken = xhr.responseText.trim();
        callback(directToken);
      } else {
        callback(null);
      }
    };
    xhr.onerror = function() { callback(null); };
    xhr.send('{}');
  }

  // === Sidebar shortcuts ===
  var shortcuts = [
    { name: 'Media', path: '/files/Media/', icon: 'photo_library' },
    { name: 'fxMain', path: '/files/fxMain/', icon: 'dns' },
    { name: 'fxTest', path: '/files/fxTest/', icon: 'bug_report' }
  ];

  function injectSidebar() {
    var sidebar = document.querySelector('nav > div');
    if (!sidebar) return false;
    if (document.getElementById('hk-shortcuts')) return true;
    var myFiles = sidebar.querySelector('a[href="/files/"]');
    if (!myFiles) return false;
    var container = document.createElement('div');
    container.id = 'hk-shortcuts';
    container.style.cssText = 'margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.1)';
    shortcuts.forEach(function(s) {
      var a = document.createElement('a');
      a.href = s.path;
      a.innerHTML = '<i class="material-icons">' + s.icon + '</i><span>' + s.name + '</span>';
      a.style.cssText = 'display:flex;align-items:center;gap:12px;padding:8px 16px;text-decoration:none;color:inherit;font-size:14px';
      container.appendChild(a);
    });
    myFiles.parentNode.insertBefore(container, myFiles.nextSibling);
    return true;
  }

  // === Download helper ===
  function triggerDownload() {
    var selected = document.querySelectorAll('[data-dir][aria-selected="true"], [data-type][aria-selected="true"]');
    var filePath;
    var isDir;

    if (selected.length === 1) {
      var name = selected[0].getAttribute('aria-label');
      var dir = selected[0].getAttribute('data-dir') === 'true';
      var currentPath = decodeURIComponent(location.pathname.replace(/^\/files/, ''));
      if (!currentPath.endsWith('/')) currentPath += '/';
      filePath = currentPath + name;
      isDir = dir;
      if (isDir) filePath += '/';
    } else if (selected.length > 1) {
      filePath = decodeURIComponent(location.pathname.replace(/^\/files/, ''));
      isDir = true;
    }

    if (!filePath) {
      filePath = decodeURIComponent(location.pathname.replace(/^\/files/, ''));
      isDir = filePath.endsWith('/');
    }

    getDirectToken(function(token) {
      if (!token) return;
      if (!filePath || filePath === '/') {
        showDownloadPopup(null, '/', true, token);
        return;
      }
      var directUrl;
      if (isDir) {
        directUrl = DIRECT_HOST + '/api/raw' + filePath + '?auth=' + token + '&algo=zip';
      } else {
        directUrl = DIRECT_HOST + '/api/raw' + filePath + '?auth=' + token;
      }
      showDownloadPopup(directUrl, filePath, isDir, token);
    });
  }

  // === Upload helper ===
  function triggerUpload(droppedFiles) {
    var filePath = decodeURIComponent(location.pathname.replace(/^\/files/, ''));
    if (!filePath.endsWith('/')) filePath += '/';

    getDirectToken(function(token) {
      if (!token) return;
      showUploadPopup(filePath, token, droppedFiles || null);
    });
  }

  // === Direct Download floating button (download only) ===
  function injectDirectButton() {
    if (document.getElementById('hk-direct-fab') && document.getElementById('hk-share-fab')) return;
    if (location.pathname === '/login') return;

    var btn = document.createElement('button');
    btn.id = 'hk-direct-fab';
    btn.innerHTML = '⚡ Download';
    btn.style.cssText = 'position:fixed;bottom:80px;right:148px;z-index:9999;padding:10px 18px;background:#10b981;color:#fff;border:none;border-radius:4px;font-weight:700;cursor:pointer;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,.3);font-family:Inter,sans-serif;';
    btn.addEventListener('click', function() {
      triggerDownload();
    });
    document.body.appendChild(btn);

    // Yellow share button (direct image/file link)
    var shareBtn = document.createElement('button');
    shareBtn.id = 'hk-share-fab';
    shareBtn.innerHTML = '🔗 Share';
    shareBtn.style.cssText = 'position:fixed;bottom:80px;right:28px;z-index:9999;padding:10px 18px;background:#eab308;color:#1a1306;border:none;border-radius:4px;font-weight:700;cursor:pointer;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,.3);font-family:Inter,sans-serif;';
    shareBtn.addEventListener('click', function() {
      // Get selected file or current file
      var selected = document.querySelectorAll('[data-dir][aria-selected="true"], [data-type][aria-selected="true"]');
      var filePath;

      if (selected.length === 1) {
        var name = selected[0].getAttribute('aria-label');
        var dir = selected[0].getAttribute('data-dir') === 'true';
        if (dir) {
          shareBtn.textContent = '✗ Cannot share folders';
          setTimeout(function(){ shareBtn.innerHTML = '🔗 Share'; }, 2000);
          return;
        }
        var currentPath = decodeURIComponent(location.pathname.replace(/^\/files/, ''));
        if (!currentPath.endsWith('/')) currentPath += '/';
        filePath = currentPath + name;
      } else if (selected.length === 0) {
        // If viewing a file directly
        filePath = decodeURIComponent(location.pathname.replace(/^\/files/, ''));
        if (filePath.endsWith('/')) {
          shareBtn.textContent = '✗ Select a file';
          setTimeout(function(){ shareBtn.innerHTML = '🔗 Share'; }, 2000);
          return;
        }
      } else {
        shareBtn.textContent = '✗ Select one file';
        setTimeout(function(){ shareBtn.innerHTML = '🔗 Share'; }, 2000);
        return;
      }

      shareBtn.textContent = '...';
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/create', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onload = function() {
        if (xhr.status === 200) {
          var data = JSON.parse(xhr.responseText);
          var shareUrl = 'https://media.homekong.cc' + data.url;
          navigator.clipboard.writeText(shareUrl).then(function() {
            shareBtn.textContent = '✓ Copied!';
            setTimeout(function(){ shareBtn.innerHTML = '🔗 Share'; }, 2000);
          });
        } else {
          shareBtn.textContent = '✗ Error';
          setTimeout(function(){ shareBtn.innerHTML = '🔗 Share'; }, 2000);
        }
      };
      xhr.onerror = function() {
        shareBtn.textContent = '✗ Failed';
        setTimeout(function(){ shareBtn.innerHTML = '🔗 Share'; }, 2000);
      };
      xhr.send(JSON.stringify({ filepath: filePath }));
    });
    document.body.appendChild(shareBtn);
  }

  function showDownloadPopup(url, filePath, isDir, token) {
    var existing = document.getElementById('hk-direct-popup');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'hk-direct-popup';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px';
    overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });

    var popup = document.createElement('div');
    popup.style.cssText = 'background:#1e293b;border-radius:12px;padding:24px;max-width:520px;width:100%;color:#f1f5f9;font-family:Inter,-apple-system,sans-serif';

    var displayPath = filePath.length > 45 ? '...' + filePath.slice(-42) : filePath;

    var content = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px"><h3 style="margin:0;font-size:1rem;color:#10b981">📥 Direct Download</h3><button id="hk-popup-close" style="background:none;border:none;color:#94a3b8;font-size:1.4rem;cursor:pointer">×</button></div>';

    if (url) {
      content += ''
        + '<p style="font-size:.7rem;color:#64748b;margin:0 0 8px;word-break:break-all">' + displayPath + '</p>'
        + (isDir ? '<p style="font-size:.7rem;color:#ef4444;margin:0 0 10px">⚠ This will download the entire folder as a ZIP file</p>' : '')
        + '<input id="hk-direct-url" type="text" value="' + url + '" readonly style="width:100%;padding:10px;background:#0f172a;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:.7rem;font-family:monospace;margin-bottom:12px">'
        + '<div style="display:flex;gap:8px">'
        + '<button id="hk-copy-btn" style="flex:1;padding:10px;background:#10b981;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:.8rem">Copy Link</button>'
        + '<a href="' + url + '" target="_blank" style="flex:1;padding:10px;background:#334155;color:#e2e8f0;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:.8rem;text-align:center;text-decoration:none">Download</a>'
        + '</div>';
    } else {
      content += '<p style="font-size:.8rem;color:#94a3b8;text-align:center">Navigate to a file or folder first</p>';
    }

    popup.innerHTML = content;
    overlay.appendChild(popup);
    document.body.appendChild(overlay);

    document.getElementById('hk-popup-close').addEventListener('click', function() { overlay.remove(); });

    var copyBtn = document.getElementById('hk-copy-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', function() {
        var input = document.getElementById('hk-direct-url');
        input.select();
        navigator.clipboard.writeText(input.value).then(function() {
          copyBtn.textContent = '✓ Copied!';
          setTimeout(function() { copyBtn.textContent = 'Copy Link'; }, 2000);
        });
      });
    }
  }

  function showUploadPopup(uploadPath, token, droppedFiles) {
    var existing = document.getElementById('hk-direct-popup');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'hk-direct-popup';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px';
    overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });

    var popup = document.createElement('div');
    popup.style.cssText = 'background:#1e293b;border-radius:12px;padding:24px;max-width:520px;width:100%;color:#f1f5f9;font-family:Inter,-apple-system,sans-serif';

    popup.innerHTML = ''
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px"><h3 style="margin:0;font-size:1rem;color:#3b82f6">📤 Direct Upload</h3><button id="hk-popup-close" style="background:none;border:none;color:#94a3b8;font-size:1.4rem;cursor:pointer">×</button></div>'
      + '<p style="font-size:.72rem;color:#94a3b8;margin:0 0 12px">Uploading to: <span style="color:#60a5fa;font-family:monospace">' + uploadPath + '</span></p>'
      + '<div id="hk-upload-zone" style="border:2px dashed #2563eb;border-radius:8px;padding:20px;text-align:center;cursor:pointer;transition:border-color .2s;background:rgba(37,99,235,.1)">'
      + '<p style="margin:0;font-size:.8rem;color:#93c5fd">Click to select files · Drag files or folders here</p>'
      + '<input id="hk-upload-input" type="file" multiple style="display:none">'
      + '<input id="hk-upload-folder" type="file" webkitdirectory style="display:none">'
      + '</div>'
      + '<div style="margin-top:8px;text-align:center"><button id="hk-folder-btn" style="background:none;border:1px solid #334155;border-radius:4px;padding:6px 12px;color:#94a3b8;font-size:.7rem;cursor:pointer">Or select a folder</button></div>'
      + '<div id="hk-upload-progress" style="margin-top:10px;max-height:200px;overflow-y:auto"></div>';

    overlay.appendChild(popup);
    document.body.appendChild(overlay);

    document.getElementById('hk-popup-close').addEventListener('click', function() { overlay.remove(); });

    var uploadZone = document.getElementById('hk-upload-zone');
    var uploadInput = document.getElementById('hk-upload-input');
    var uploadFolder = document.getElementById('hk-upload-folder');
    var folderBtn = document.getElementById('hk-folder-btn');

    uploadZone.addEventListener('click', function() { uploadInput.click(); });
    folderBtn.addEventListener('click', function() { uploadFolder.click(); });

    uploadZone.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.stopImmediatePropagation();
      uploadZone.style.borderColor = '#10b981';
    });
    uploadZone.addEventListener('dragleave', function() {
      uploadZone.style.borderColor = '#2563eb';
    });
    uploadZone.addEventListener('drop', function(e) {
      e.preventDefault();
      e.stopImmediatePropagation();
      uploadZone.style.borderColor = '#2563eb';
      // Use webkitGetAsEntry to handle folders
      if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
        readDroppedItems(e.dataTransfer.items, uploadPath, token);
      } else {
        handleUpload(e.dataTransfer.files, uploadPath, token);
      }
    });
    uploadInput.addEventListener('change', function() {
      if (uploadInput.files.length) handleUpload(uploadInput.files, uploadPath, token);
    });
    uploadFolder.addEventListener('change', function() {
      if (uploadFolder.files.length) {
        // webkitdirectory gives flat file list with webkitRelativePath
        handleFolderUpload(uploadFolder.files, uploadPath, token);
      }
    });

    // If files were already dropped (from page drag), process them
    if (droppedFiles) {
      if (droppedFiles._items) {
        readDroppedItems(droppedFiles._items, uploadPath, token);
      } else if (droppedFiles.length > 0) {
        handleUpload(droppedFiles, uploadPath, token);
      }
    }
  }

  // Read dropped items recursively (handles folders)
  function readDroppedItems(items, uploadPath, token) {
    var allFiles = [];
    var pending = 0;

    function readEntry(entry, path) {
      if (entry.isFile) {
        pending++;
        entry.file(function(file) {
          allFiles.push({ file: file, relativePath: path + file.name });
          pending--;
          if (pending === 0) doneReading();
        });
      } else if (entry.isDirectory) {
        pending++;
        var reader = entry.createReader();
        reader.readEntries(function(entries) {
          pending--;
          entries.forEach(function(e) {
            readEntry(e, path + entry.name + '/');
          });
          if (pending === 0) doneReading();
        });
      }
    }

    for (var i = 0; i < items.length; i++) {
      var entry = items[i].webkitGetAsEntry ? items[i].webkitGetAsEntry() : null;
      if (entry) {
        readEntry(entry, '');
      } else if (items[i].getAsFile) {
        var f = items[i].getAsFile();
        if (f) allFiles.push({ file: f, relativePath: f.name });
      }
    }

    // In case everything was synchronous (only files, no dirs)
    if (pending === 0) doneReading();

    function doneReading() {
      if (allFiles.length === 0) return;
      handleFolderUploadEntries(allFiles, uploadPath, token);
    }
  }

  // Upload files that have relative paths (from folder drop or webkitdirectory)
  function handleFolderUpload(files, basePath, token) {
    var entries = [];
    Array.from(files).forEach(function(f) {
      entries.push({ file: f, relativePath: f.webkitRelativePath || f.name });
    });
    handleFolderUploadEntries(entries, basePath, token);
  }

  function handleFolderUploadEntries(entries, basePath, token) {
    var progressEl = document.getElementById('hk-upload-progress');
    progressEl.innerHTML = '';
    var total = entries.length;
    var completed = 0;
    var failed = 0;

    // Show count
    var info = document.createElement('p');
    info.style.cssText = 'font-size:.75rem;color:#93c5fd;margin:0 0 8px';
    info.textContent = 'Uploading ' + total + ' file' + (total > 1 ? 's' : '') + '...';
    progressEl.appendChild(info);

    // Collect unique subdirectories and ensure they exist first
    var dirs = {};
    entries.forEach(function(entry) {
      var parts = entry.relativePath.split('/');
      if (parts.length > 1) {
        var dir = parts.slice(0, -1).join('/') + '/';
        dirs[dir] = true;
      }
    });
    var dirList = Object.keys(dirs).sort();
    var dirsCreated = 0;
    var totalDirs = dirList.length;

    if (totalDirs === 0) {
      doFolderUploads();
    } else {
      dirList.forEach(function(dir) {
        var mkdirUrl = DIRECT_HOST + '/api/resources' + basePath + dir + '?auth=' + token;
        var xhr = new XMLHttpRequest();
        xhr.open('POST', mkdirUrl, true);
        xhr.onload = function() { dirsCreated++; if (dirsCreated >= totalDirs) doFolderUploads(); };
        xhr.onerror = function() { dirsCreated++; if (dirsCreated >= totalDirs) doFolderUploads(); };
        xhr.send();
      });
    }

    function doFolderUploads() {
      entries.forEach(function(entry) {
        var item = document.createElement('div');
        item.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:.7rem';
        item.innerHTML = '<span style="flex:1;color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + entry.relativePath + '</span><span class="hk-up-status" style="color:#94a3b8;min-width:70px;text-align:right">0%</span>';
        progressEl.appendChild(item);

        var statusEl = item.querySelector('.hk-up-status');
        var uploadUrl = DIRECT_HOST + '/api/resources' + basePath + encodeURIComponent(entry.relativePath).replace(/%2F/g, '/') + '?auth=' + token + '&override=true';

        var xhr = new XMLHttpRequest();
        xhr.open('POST', uploadUrl, true);

        xhr.upload.onprogress = function(e) {
          if (e.lengthComputable) {
            var pct = Math.round((e.loaded / e.total) * 100);
            statusEl.textContent = pct + '%';
            statusEl.style.color = '#60a5fa';
          }
        };
        xhr.onload = function() {
          if (xhr.status >= 200 && xhr.status < 300) {
            statusEl.textContent = '✓';
            statusEl.style.color = '#10b981';
            completed++;
          } else {
            var errMsg = xhr.status + '';
            try { var body = xhr.responseText; if (body && body.length < 40) errMsg += ' ' + body; } catch(e) {}
            statusEl.textContent = '✗ ' + errMsg;
            statusEl.style.color = '#ef4444';
            failed++;
            completed++;
          }
          if (completed >= total) folderDone();
        };
        xhr.onerror = function() {
          statusEl.textContent = '✗ Network';
          statusEl.style.color = '#ef4444';
          failed++;
          completed++;
          if (completed >= total) folderDone();
        };

        xhr.send(entry.file);
      });
    }

    function folderDone() {
      showUploadResult(total, failed);
    }
  }

  function handleUpload(files, destPath, token) {
    var progressEl = document.getElementById('hk-upload-progress');
    progressEl.innerHTML = '';
    var fileArray = Array.from(files);
    var total = fileArray.length;
    var completed = 0;
    var failed = 0;

    // Pre-check for existing files
    var checkUrl = DIRECT_HOST + '/api/resources' + destPath + '?auth=' + token;
    var xhr = new XMLHttpRequest();
    xhr.open('GET', checkUrl, true);
    xhr.onload = function() {
      var existing = [];
      var existingNames = [];
      if (xhr.status === 200) {
        try {
          var data = JSON.parse(xhr.responseText);
          var items = data.items || [];
          existingNames = items.map(function(i) { return i.name; });
          fileArray.forEach(function(f) {
            if (existingNames.indexOf(f.name) !== -1) existing.push(f.name);
          });
        } catch(e) {}
      }

      if (existing.length > 0) {
        // Show conflict prompt
        var conflict = document.createElement('div');
        conflict.style.cssText = 'margin-bottom:12px;padding:12px;background:#78350f;border:1px solid #f59e0b;border-radius:6px';
        conflict.innerHTML = ''
          + '<p style="margin:0 0 8px;font-size:.78rem;color:#fde68a;font-weight:600">⚠ ' + existing.length + ' file' + (existing.length > 1 ? 's' : '') + ' already exist' + (existing.length === 1 ? 's' : '') + ':</p>'
          + '<p style="margin:0 0 10px;font-size:.7rem;color:#fcd34d;font-family:monospace;word-break:break-all">' + existing.join(', ') + '</p>'
          + '<div style="display:flex;gap:6px;flex-wrap:wrap">'
          + '<button id="hk-overwrite-btn" style="flex:1;padding:8px;background:#f59e0b;color:#1a1306;border:none;border-radius:4px;cursor:pointer;font-weight:600;font-size:.75rem">Overwrite</button>'
          + '<button id="hk-rename-btn" style="flex:1;padding:8px;background:#6366f1;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:600;font-size:.75rem">Rename</button>'
          + '<button id="hk-skip-btn" style="flex:1;padding:8px;background:#334155;color:#e2e8f0;border:none;border-radius:4px;cursor:pointer;font-weight:600;font-size:.75rem">Skip</button>'
          + '<button id="hk-cancel-btn" style="flex:1;padding:8px;background:#7f1d1d;color:#fca5a5;border:none;border-radius:4px;cursor:pointer;font-weight:600;font-size:.75rem">Cancel</button>'
          + '</div>';
        progressEl.appendChild(conflict);

        document.getElementById('hk-overwrite-btn').addEventListener('click', function() {
          conflict.remove();
          startUploads(fileArray, destPath, token, true);
        });
        document.getElementById('hk-rename-btn').addEventListener('click', function() {
          conflict.remove();
          // Rename conflicting files by adding _1, _2 etc
          var renamed = fileArray.map(function(f) {
            if (existing.indexOf(f.name) !== -1) {
              var dot = f.name.lastIndexOf('.');
              var base = dot > 0 ? f.name.substring(0, dot) : f.name;
              var ext = dot > 0 ? f.name.substring(dot) : '';
              var num = 1;
              var newName = base + '_' + num + ext;
              while (existingNames.indexOf(newName) !== -1) { num++; newName = base + '_' + num + ext; }
              return { file: f, name: newName };
            }
            return { file: f, name: f.name };
          });
          startUploadsRenamed(renamed, destPath, token);
        });
        document.getElementById('hk-skip-btn').addEventListener('click', function() {
          conflict.remove();
          var filtered = fileArray.filter(function(f) { return existing.indexOf(f.name) === -1; });
          if (filtered.length === 0) {
            progressEl.innerHTML = '<p style="font-size:.8rem;color:#94a3b8;text-align:center">Nothing to upload — all files already exist</p>';
            return;
          }
          startUploads(filtered, destPath, token, false);
        });
        document.getElementById('hk-cancel-btn').addEventListener('click', function() {
          conflict.remove();
          progressEl.innerHTML = '';
        });
      } else {
        startUploads(fileArray, destPath, token, true);
      }
    };
    xhr.onerror = function() {
      // Can't check — just upload with override
      startUploads(fileArray, destPath, token, true);
    };
    xhr.send();
  }

  function startUploads(files, destPath, token, override) {
    var progressEl = document.getElementById('hk-upload-progress');
    var total = files.length;
    var completed = 0;
    var failed = 0;

    // Ensure target directory exists first
    var ensureDir = new XMLHttpRequest();
    ensureDir.open('POST', DIRECT_HOST + '/api/resources' + destPath + '?auth=' + token, true);
    ensureDir.onload = function() { doUploads(); };
    ensureDir.onerror = function() { doUploads(); };
    ensureDir.send();

    function doUploads() {
      files.forEach(function(file) {
        var item = document.createElement('div');
        item.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:.75rem';
        item.innerHTML = '<span style="flex:1;color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + file.name + '</span><span class="hk-up-status" style="color:#94a3b8;min-width:80px;text-align:right">0%</span>';
        progressEl.appendChild(item);

        var statusEl = item.querySelector('.hk-up-status');
        var uploadUrl = DIRECT_HOST + '/api/resources' + destPath + encodeURIComponent(file.name) + '?auth=' + token + (override ? '&override=true' : '');

        var xhr = new XMLHttpRequest();
        xhr.open('POST', uploadUrl, true);

        xhr.upload.onprogress = function(e) {
          if (e.lengthComputable) {
            var pct = Math.round((e.loaded / e.total) * 100);
            statusEl.textContent = pct + '%';
            statusEl.style.color = '#60a5fa';
          }
        };
        xhr.onload = function() {
          if (xhr.status >= 200 && xhr.status < 300) {
            statusEl.textContent = '✓ Done';
            statusEl.style.color = '#10b981';
            completed++;
          } else {
            var errMsg = xhr.status + '';
            try { var body = xhr.responseText; if (body && body.length < 50) errMsg += ' ' + body; } catch(e) {}
            statusEl.textContent = '✗ ' + errMsg;
            statusEl.style.color = '#ef4444';
            failed++;
            completed++;
          }
          checkAllDone();
        };
        xhr.onerror = function() {
          statusEl.textContent = '✗ Network error';
          statusEl.style.color = '#ef4444';
          failed++;
          completed++;
          checkAllDone();
        };

        xhr.send(file);
      });
    }

    function checkAllDone() {
      if (completed < total) return;
      showUploadResult(total, failed);
    }
  }

  function startUploadsRenamed(renamedFiles, destPath, token) {
    var progressEl = document.getElementById('hk-upload-progress');
    var total = renamedFiles.length;
    var completed = 0;
    var failed = 0;

    renamedFiles.forEach(function(entry) {
      var item = document.createElement('div');
      item.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:.75rem';
      var label = entry.name !== entry.file.name ? entry.file.name + ' → ' + entry.name : entry.name;
      item.innerHTML = '<span style="flex:1;color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + label + '</span><span class="hk-up-status" style="color:#94a3b8;min-width:60px;text-align:right">0%</span>';
      progressEl.appendChild(item);

      var statusEl = item.querySelector('.hk-up-status');
      var uploadUrl = DIRECT_HOST + '/api/resources' + destPath + encodeURIComponent(entry.name) + '?auth=' + token;

      var xhr = new XMLHttpRequest();
      xhr.open('POST', uploadUrl, true);

      xhr.upload.onprogress = function(e) {
        if (e.lengthComputable) {
          var pct = Math.round((e.loaded / e.total) * 100);
          statusEl.textContent = pct + '%';
          statusEl.style.color = '#60a5fa';
        }
      };
      xhr.onload = function() {
        if (xhr.status >= 200 && xhr.status < 300) {
          statusEl.textContent = '✓ Done';
          statusEl.style.color = '#10b981';
          completed++;
        } else {
          statusEl.textContent = '✗ Error ' + xhr.status;
          statusEl.style.color = '#ef4444';
          failed++;
          completed++;
        }
        if (completed >= total) doneRename();
      };
      xhr.onerror = function() {
        statusEl.textContent = '✗ Failed';
        statusEl.style.color = '#ef4444';
        failed++;
        completed++;
        if (completed >= total) doneRename();
      };

      xhr.send(entry.file);
    });

    function doneRename() {
      showUploadResult(total, failed);
    }
  }

  // === Disable built-in drag & drop and use ours instead ===
  function disableBuiltinDragDrop() {
    if (document.getElementById('hk-no-dragdrop')) return;

    var dragCounter = 0;

    document.addEventListener('dragenter', function(e) {
      if (e.target.closest && e.target.closest('#hk-upload-zone')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      dragCounter++;
      if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.indexOf('Files') !== -1) {
        showDragOverlay();
      }
    }, true);

    document.addEventListener('dragover', function(e) {
      if (e.target.closest && e.target.closest('#hk-upload-zone')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);

    document.addEventListener('dragleave', function(e) {
      if (e.target.closest && e.target.closest('#hk-upload-zone')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        hideDragOverlay();
      }
    }, true);

    document.addEventListener('drop', function(e) {
      if (e.target.closest && e.target.closest('#hk-upload-zone')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      dragCounter = 0;
      hideDragOverlay();
      if (e.dataTransfer && e.dataTransfer.items && e.dataTransfer.items.length > 0) {
        var itemsCopy = [];
        for (var i = 0; i < e.dataTransfer.items.length; i++) {
          itemsCopy.push(e.dataTransfer.items[i]);
        }
        var wrapped = e.dataTransfer.files;
        wrapped._items = itemsCopy;
        triggerUpload(wrapped);
      } else if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        triggerUpload(e.dataTransfer.files);
      }
    }, true);

    window.addEventListener('dragover', function(e) { e.preventDefault(); }, true);
    window.addEventListener('drop', function(e) { e.preventDefault(); }, true);

    // Hide built-in upload UI + custom scrollbar for upload progress
    var style = document.createElement('style');
    style.id = 'hk-no-dragdrop';
    style.textContent = '.upload-files,.upload-overlay,.upload,.drop-overlay,[class*="upload"]:not(#hk-upload-zone):not(#hk-upload-input):not(#hk-upload-folder):not(#hk-upload-progress){display:none!important;pointer-events:none!important}.Vue-Toastification__toast{display:none!important}#hk-upload-progress::-webkit-scrollbar{width:6px}#hk-upload-progress::-webkit-scrollbar-track{background:#0f172a;border-radius:3px}#hk-upload-progress::-webkit-scrollbar-thumb{background:#334155;border-radius:3px}#hk-upload-progress::-webkit-scrollbar-thumb:hover{background:#475569}#hk-upload-progress{scrollbar-width:thin;scrollbar-color:#334155 #0f172a}';
    document.head.appendChild(style);
  }

  // === Upload complete screen ===
  function showUploadResult(total, failed) {
    var existing = document.getElementById('hk-direct-popup');
    // Grab error info from progress before removing
    var errors = [];
    var progressEl = document.getElementById('hk-upload-progress');
    if (progressEl && failed > 0) {
      progressEl.querySelectorAll('.hk-up-status').forEach(function(el) {
        if (el.textContent.indexOf('✗') !== -1) {
          var name = el.parentElement.querySelector('span:first-child');
          errors.push((name ? name.textContent : 'unknown') + ' — ' + el.textContent.replace('✗ ', ''));
        }
      });
    }
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'hk-direct-popup';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px';
    overlay.addEventListener('click', function(e) { if (e.target === overlay) closeResult(); });

    var popup = document.createElement('div');
    popup.style.cssText = 'background:#1e293b;border-radius:12px;padding:32px;max-width:400px;width:100%;color:#f1f5f9;font-family:Inter,-apple-system,sans-serif;text-align:center';

    if (failed === 0) {
      popup.innerHTML = ''
        + '<div style="font-size:2.5rem;margin-bottom:12px">✓</div>'
        + '<h3 style="margin:0 0 8px;font-size:1rem;color:#6ee7b7">Upload Complete</h3>'
        + '<p style="margin:0;font-size:.8rem;color:#94a3b8">' + total + ' file' + (total > 1 ? 's' : '') + ' uploaded successfully</p>';
    } else {
      var errorHtml = errors.length > 0
        ? '<div style="text-align:left;margin-top:12px;max-height:120px;overflow-y:auto;padding:8px;background:#0f172a;border-radius:6px;font-size:.68rem;color:#fca5a5;font-family:monospace;scrollbar-width:thin;scrollbar-color:#334155 #0f172a">' + errors.map(function(e) { return '<div style="margin-bottom:4px">' + e + '</div>'; }).join('') + '</div>'
        : '';
      popup.innerHTML = ''
        + '<div style="font-size:2.5rem;margin-bottom:12px">⚠</div>'
        + '<h3 style="margin:0 0 8px;font-size:1rem;color:#fca5a5">Upload Finished</h3>'
        + '<p style="margin:0;font-size:.8rem;color:#94a3b8">' + (total - failed) + '/' + total + ' uploaded · ' + failed + ' failed</p>'
        + errorHtml;
    }

    overlay.appendChild(popup);
    document.body.appendChild(overlay);

    function closeResult() {
      overlay.remove();
      var current = window.location.pathname;
      window.history.pushState(null, '', current + '?t=' + Date.now());
      window.history.replaceState(null, '', current);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }

    // Auto-close after 2s if success, 5s if errors
    setTimeout(closeResult, failed === 0 ? 2000 : 5000);
  }

  function showDragOverlay() {
    if (document.getElementById('hk-drag-overlay')) return;
    var overlay = document.createElement('div');
    overlay.id = 'hk-drag-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(37,99,235,.15);border:3px dashed #3b82f6;z-index:99998;display:flex;align-items:center;justify-content:center';
    overlay.innerHTML = '<p style="font-size:1.2rem;color:#93c5fd;font-weight:700;font-family:Inter,sans-serif;background:rgba(15,23,42,.8);padding:16px 32px;border-radius:8px;pointer-events:none">📤 Drop files to upload</p>';
    document.body.appendChild(overlay);
  }

  function hideDragOverlay() {
    var overlay = document.getElementById('hk-drag-overlay');
    if (overlay) overlay.remove();
  }

  // === Replace header upload/download buttons with our direct versions ===
  function hijackHeaderButtons() {
    var buttons = document.querySelectorAll('header button, header .action');
    buttons.forEach(function(btn) {
      var icon = btn.querySelector('i');
      if (!icon) return;
      var iconText = icon.textContent.trim();

      // Hijack upload button → our upload popup
      if (iconText === 'file_upload' && !btn.dataset.hkHijacked) {
        btn.dataset.hkHijacked = 'true';
        btn.addEventListener('click', function(e) {
          e.preventDefault();
          e.stopImmediatePropagation();
          triggerUpload();
        }, true);
      }

      // Hijack download button → our download popup
      if (iconText === 'file_download' && !btn.dataset.hkHijacked) {
        btn.dataset.hkHijacked = 'true';
        btn.addEventListener('click', function(e) {
          e.preventDefault();
          e.stopImmediatePropagation();
          triggerDownload();
        }, true);
      }
    });
  }

  // === Mobile fix: make top-right buttons scrollable ===
  function fixMobileOverflow() {
    var style = document.createElement('style');
    style.id = 'hk-mobile-fix';
    style.textContent = '@media(max-width:768px){header .action{font-size:0!important;padding:8px!important;min-width:36px}header .action i{font-size:20px!important}header{flex-wrap:nowrap;overflow-x:auto;-webkit-overflow-scrolling:touch}#header-buttons{overflow-x:auto;white-space:nowrap;max-width:60vw}}';
    if (!document.getElementById('hk-mobile-fix')) document.head.appendChild(style);
  }

  // === Init ===
  function init() {
    injectSidebar();
    injectDirectButton();
    disableBuiltinDragDrop();
    hijackHeaderButtons();
    fixMobileOverflow();
  }

  // Run on load and watch for SPA navigation
  if (document.readyState === 'complete') init();
  else window.addEventListener('load', init);

  var observer = new MutationObserver(function() {
    if (!document.getElementById('hk-shortcuts')) injectSidebar();
    if (!document.getElementById('hk-direct-fab')) injectDirectButton();
    hijackHeaderButtons();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Re-inject on SPA route change
  var lastPath = location.pathname;
  setInterval(function() {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      if (!document.getElementById('hk-direct-fab')) injectDirectButton();
    }
  }, 500);
})();
