/* readpaper front-end (static github.io build): PDF.js + selection -> quote, chat via Cloudflare Worker. */
(() => {
  const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  if (window['pdfjsLib']) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  }

  // ---- Worker URL config ----
  const WORKER_URL = ((window.READPAPER_CONFIG || {}).WORKER_URL || '').replace(/\/+$/, '');
  function ensureConfigured() {
    if (!WORKER_URL) {
      alert('未配置 WORKER_URL：请编辑 public/config.js 把 WORKER_URL 填成你的 Cloudflare Worker 地址');
      return false;
    }
    return true;
  }

  // ---- Browser-side library (localStorage) ----
  // Schema: { [id]: { id, title, authors, createdAt, updatedAt, history: [{role,content,ts}] } }
  const LIB_KEY = 'readpaper.library.v1';
  function readLib() {
    try {
      const raw = localStorage.getItem(LIB_KEY);
      const obj = raw ? JSON.parse(raw) : {};
      return obj && typeof obj === 'object' ? obj : {};
    } catch { return {}; }
  }
  function writeLib(obj) {
    try { localStorage.setItem(LIB_KEY, JSON.stringify(obj)); } catch (e) {
      console.warn('[lib] write failed:', e.message);
    }
  }
  function libUpsert(id, title, authors) {
    const lib = readLib();
    const now = new Date().toISOString();
    if (!lib[id]) lib[id] = { id, title: title || '', authors: authors || [], createdAt: now, updatedAt: now, history: [] };
    else {
      if (title) lib[id].title = title;
      if (authors && authors.length) lib[id].authors = authors;
      lib[id].updatedAt = now;
    }
    writeLib(lib);
    return lib[id];
  }
  function libAppendTurn(id, role, content) {
    const lib = readLib();
    if (!lib[id]) return;
    const ts = new Date().toISOString();
    lib[id].history = lib[id].history || [];
    lib[id].history.push({ role, content, ts });
    lib[id].updatedAt = ts;
    writeLib(lib);
  }
  function libList() {
    const lib = readLib();
    return Object.values(lib).map(p => ({
      id: p.id,
      title: p.title || '',
      authors: p.authors || [],
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      turns: Array.isArray(p.history) ? p.history.length : 0,
    })).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }
  function libGet(id) {
    const lib = readLib();
    return lib[id] || null;
  }
  function libDelete(id) {
    const lib = readLib();
    if (lib[id]) { delete lib[id]; writeLib(lib); }
    // Also remove the stored PDF blob (if any)
    idbDelete(id).catch(() => {});
  }

  // ---- Browser-side PDF storage (IndexedDB) — for uploaded PDFs ----
  const IDB_NAME = 'readpaper';
  const IDB_STORE = 'pdfs';
  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function idbPut(id, blob) {
    return idbOpen().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(blob, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }
  function idbGet(id) {
    return idbOpen().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    }));
  }
  function idbDelete(id) {
    return idbOpen().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const loadForm = $('loadForm');
  const arxivInput = $('arxivInput');
  const pdfContainer = $('pdfContainer');
  const paperMeta = $('paperMeta');
  const chatLog = $('chatLog');
  const chatForm = $('chatForm');
  const chatInput = $('chatInput');
  const sendBtn = $('sendBtn');
  const quoteBox = $('quoteBox');
  const quoteText = $('quoteText');
  const quoteRemove = $('quoteRemove');
  const clearChatBtn = $('clearChat');
  const divider = $('divider');
  const main = document.querySelector('.main');
  const leftPane = $('leftPane');
  const pdfToolbar = $('pdfToolbar');
  const zoomInBtn = $('zoomIn');
  const zoomOutBtn = $('zoomOut');
  const zoomResetBtn = $('zoomReset');
  const zoomLevelEl = $('zoomLevel');
  const visionToggle = $('visionToggle');
  const libraryBtn = $('libraryBtn');
  const libraryOverlay = $('libraryOverlay');
  const libraryDrawer = $('libraryDrawer');
  const libraryClose = $('libraryClose');
  const libraryList = $('libraryList');
  const uploadBtn = $('uploadBtn');
  const uploadInput = $('uploadInput');
  const dropHint = $('dropHint');

  // ---- State ----
  const state = {
    paperTitle: '',
    paperContext: '',  // full text extracted from PDF, sent to backend
    paperImages: [],   // [{ media_type, data(base64) }] one per page
    pendingQuote: '',
    history: [],       // [{role:'user'|'assistant', content}]
    currentArxivId: '',
    streaming: false,
    pdf: null,         // current PDFDocumentProxy
    baseScale: 1.4,    // initial render scale (pixel-perfect)
    zoom: 1.0,         // user CSS scale on top of baseScale
    sendImages: true,  // toggle: include page images in next request
  };

  // ---- arXiv input parsing ----
  function extractArxivId(input) {
    if (!input) return null;
    const s = input.trim();
    const re = /(\d{4}\.\d{4,5})(v\d+)?|([a-z\-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/i;
    const m = s.match(re);
    if (m) return (m[1] || m[3]) + (m[2] || m[4] || '');
    return null;
  }

  // ---- Load paper ----
  loadForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!ensureConfigured()) return;
    const id = extractArxivId(arxivInput.value);
    if (!id) { alert('看起来不是合法的 arXiv ID 或链接'); return; }
    await loadPaper(id);
  });

  async function loadPaper(id, opts) {
    opts = opts || {};
    const isUpload = /^upload-[a-f0-9]{6,64}$/i.test(id);
    state.currentArxivId = id;
    state.paperContext = '';
    state.paperTitle = '';
    state.paperImages = [];
    state.history = [];
    chatLog.innerHTML = '<div class="empty-chat"><div class="empty-chat-icon">💬</div><div>左侧划词后可作为引用，或直接提问</div></div>';
    paperMeta.textContent = '加载中…';
    pdfContainer.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><div class="empty-title">正在加载 PDF</div><div class="empty-desc">' + (isUpload ? '从本地读取' : '通过 Worker 代理拉取 arXiv') + '，请稍候</div></div>';

    let pdfSource;
    if (isUpload) {
      const title = opts.title || (libGet(id) && libGet(id).title) || id;
      state.paperTitle = title;
      paperMeta.textContent = title;
      paperMeta.title = title;
      libUpsert(id, title, []);
      try {
        const blob = await idbGet(id);
        if (!blob) throw new Error('本地找不到这份上传的 PDF（可能换了浏览器或清过缓存）');
        pdfSource = { data: await blob.arrayBuffer() };
      } catch (err) {
        pdfContainer.innerHTML = `<div class="empty-state" style="border-color:#e9b5ad;color:#8a2a1a"><div class="empty-icon">⚠️</div><div class="empty-title">PDF 加载失败</div><div class="empty-desc">${escapeHtml(err.message || String(err))}</div></div>`;
        return;
      }
    } else {
      if (!ensureConfigured()) return;
      // arXiv metadata via Worker (non-blocking display)
      fetch(`${WORKER_URL}/arxiv/${encodeURIComponent(id)}/meta`)
        .then(r => r.json())
        .then(meta => {
          if (meta && meta.title) {
            state.paperTitle = meta.title;
            paperMeta.textContent = meta.title + (meta.authors?.length ? ' — ' + meta.authors.slice(0, 3).join(', ') : '');
            paperMeta.title = meta.title + (meta.authors?.length ? '\n' + meta.authors.join(', ') : '');
          }
          libUpsert(id, meta && meta.title || '', meta && meta.authors || []);
        })
        .catch(() => { libUpsert(id, '', []); });
      pdfSource = { url: `${WORKER_URL}/arxiv/${encodeURIComponent(id)}.pdf` };
    }

    // Fetch + render
    try {
      const loadingTask = pdfjsLib.getDocument(pdfSource);
      const pdf = await loadingTask.promise;
      state.pdf = pdf;
      pdfContainer.innerHTML = '';
      pdfToolbar.hidden = false;
      const fullText = [];
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const txt = await renderPage(page, pdfContainer);
        fullText.push(txt);
        capturePageImage(page).then((img) => { if (img) state.paperImages[p - 1] = img; }).catch(() => {});
      }
      state.paperContext = fullText.join('\n\n');
      applyZoom();
    } catch (err) {
      pdfContainer.innerHTML = `<div class="empty-state" style="border-color:#e9b5ad;color:#8a2a1a"><div class="empty-icon">⚠️</div><div class="empty-title">PDF 加载失败</div><div class="empty-desc">${escapeHtml(err.message || String(err))}</div></div>`;
    }
  }

  // ---- Render one page with text layer ----
  async function renderPage(page, container) {
    const viewport = page.getViewport({ scale: state.baseScale });

    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page-wrapper';
    wrapper.dataset.baseW = viewport.width;
    wrapper.dataset.baseH = viewport.height;

    const pageDiv = document.createElement('div');
    pageDiv.className = 'pdf-page';
    pageDiv.style.width = viewport.width + 'px';
    pageDiv.style.height = viewport.height + 'px';

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const ratio = window.devicePixelRatio || 1;
    canvas.width = viewport.width * ratio;
    canvas.height = viewport.height * ratio;
    canvas.style.width = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';
    pageDiv.appendChild(canvas);

    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';
    textLayerDiv.style.width = viewport.width + 'px';
    textLayerDiv.style.height = viewport.height + 'px';
    pageDiv.appendChild(textLayerDiv);

    wrapper.appendChild(pageDiv);
    container.appendChild(wrapper);

    await page.render({
      canvasContext: ctx,
      viewport,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null,
    }).promise;

    const textContent = await page.getTextContent();
    // pdf.js renderTextLayer
    const renderer = pdfjsLib.renderTextLayer({
      textContentSource: textContent,
      container: textLayerDiv,
      viewport,
      textDivs: [],
    });
    if (renderer && renderer.promise) await renderer.promise;

    // Concatenate page text for context
    return textContent.items.map(it => it.str).join(' ');
  }

  // ---- Capture page as JPEG for Claude vision ----
  async function capturePageImage(page) {
    const TARGET_W = 1100;
    const v1 = page.getViewport({ scale: 1 });
    const scale = Math.min(2.0, TARGET_W / v1.width);
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = vp.width;
    c.height = vp.height;
    const cx = c.getContext('2d');
    // Fill white so transparent backgrounds don't become black after JPEG encode
    cx.fillStyle = '#ffffff';
    cx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: cx, viewport: vp }).promise;
    const dataUrl = c.toDataURL('image/jpeg', 0.78);
    const i = dataUrl.indexOf(',');
    if (i < 0) return null;
    return { media_type: 'image/jpeg', data: dataUrl.slice(i + 1) };
  }

  // ---- Markdown rendering ----
  if (window.marked) {
    marked.setOptions({
      gfm: true,
      breaks: false,   // single newline = soft wrap (no <br>); paragraph spacing only on blank line
      headerIds: false,
      mangle: false,
      highlight: (code, lang) => {
        if (window.hljs) {
          try {
            if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
            return hljs.highlightAuto(code).value;
          } catch (_) {}
        }
        return code;
      },
    });
  }

  function renderMarkdownInto(el, raw) {
    if (!window.marked) { el.textContent = raw; return; }
    // Protect $...$ and $$...$$ from marked's parser by replacing with placeholders,
    // then restoring before KaTeX processes them.
    const mathBlocks = [];
    const protectedRaw = raw
      .replace(/\$\$([\s\S]+?)\$\$/g, (_m, body) => {
        mathBlocks.push({ display: true, body });
        return `\u0000MATHBLOCK${mathBlocks.length - 1}\u0000`;
      })
      .replace(/(?<!\\)\$([^\n$]+?)(?<!\\)\$/g, (_m, body) => {
        mathBlocks.push({ display: false, body });
        return `\u0000MATHBLOCK${mathBlocks.length - 1}\u0000`;
      });
    let html = marked.parse(protectedRaw);
    html = html.replace(/\u0000MATHBLOCK(\d+)\u0000/g, (_m, i) => {
      const m = mathBlocks[+i];
      const wrapTag = m.display ? 'div' : 'span';
      const cls = m.display ? 'math-display' : 'math-inline';
      // Encode body so DOMPurify keeps it; KaTeX will read data-math
      return `<${wrapTag} class="${cls}" data-math="${encodeURIComponent(m.body)}" data-display="${m.display ? '1' : '0'}"></${wrapTag}>`;
    });
    if (window.DOMPurify) {
      html = DOMPurify.sanitize(html, {
        ADD_ATTR: ['data-math', 'data-display'],
      });
    }
    el.innerHTML = html;
    // Render math placeholders
    if (window.katex) {
      el.querySelectorAll('[data-math]').forEach((node) => {
        const body = decodeURIComponent(node.getAttribute('data-math') || '');
        const display = node.getAttribute('data-display') === '1';
        try {
          katex.render(body, node, { throwOnError: false, displayMode: display });
        } catch (_) {
          node.textContent = (display ? '$$' : '$') + body + (display ? '$$' : '$');
        }
      });
    }
  }

  // ---- Selection -> quote ----
  document.addEventListener('mouseup', () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!leftPane.contains(range.commonAncestorContainer)) return;
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!text || text.length < 2) return;
    setQuote(text);
  });

  function setQuote(text) {
    state.pendingQuote = text;
    quoteText.textContent = text;
    quoteBox.classList.remove('hidden');
    chatInput.focus();
  }
  function clearQuote() {
    state.pendingQuote = '';
    quoteText.textContent = '';
    quoteBox.classList.add('hidden');
  }
  quoteRemove.addEventListener('click', clearQuote);

  // ---- Chat ----
  chatInput.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      chatForm.requestSubmit();
    }
  });

  clearChatBtn.addEventListener('click', () => {
    state.history = [];
    chatLog.innerHTML = '<div class="empty-chat"><div class="empty-chat-icon">💬</div><div>左侧划词后可作为引用，或直接提问</div></div>';
  });

  function removeEmptyChat() {
    const e = chatLog.querySelector('.empty-chat');
    if (e) e.remove();
  }

  chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.streaming) return;
    const userText = chatInput.value.trim();
    if (!userText && !state.pendingQuote) return;

    const quote = state.pendingQuote;
    // Compose the message: quote (as a block) + user question
    let composed = '';
    if (quote) composed += `> ${quote}\n\n`;
    composed += userText || '请解释这段内容。';

    appendMessage('user', { quote, text: userText || '请解释这段内容。' });
    chatInput.value = '';
    clearQuote();
    state.history.push({ role: 'user', content: composed });
    saveTurn('user', composed);
    await streamAssistant();
  });

  async function streamAssistant() {
    state.streaming = true;
    sendBtn.disabled = true;

    const bubble = document.createElement('div');
    bubble.className = 'msg assistant cursor-blink';
    chatLog.appendChild(bubble);
    chatLog.scrollTop = chatLog.scrollHeight;

    let assistantText = '';
    let pendingRender = null;
    const renderProgressive = () => {
      pendingRender = null;
      // Strip a trailing partial code fence so marked doesn't break mid-stream.
      renderMarkdownInto(bubble, assistantText);
    };
    const scheduleRender = () => {
      if (pendingRender) return;
      pendingRender = setTimeout(renderProgressive, 80);
    };
    try {
      if (!ensureConfigured()) throw new Error('未配置 Worker URL');
      const resp = await fetch(`${WORKER_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: state.history,
          paperContext: state.paperContext,
          paperTitle: state.paperTitle,
          paperImages: state.sendImages ? state.paperImages.filter(Boolean) : [],
        }),
      });
      if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE parsing: split by blank line
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const evMatch = chunk.match(/^event: (.+)$/m);
          const dataMatch = chunk.match(/^data: (.+)$/m);
          if (!dataMatch) continue;
          const event = evMatch ? evMatch[1].trim() : 'message';
          let data;
          try { data = JSON.parse(dataMatch[1]); } catch { continue; }
          if (event === 'delta' && data.text) {
            assistantText += data.text;
            scheduleRender();
            chatLog.scrollTop = chatLog.scrollHeight;
          } else if (event === 'error') {
            throw new Error(data.message || 'stream error');
          } else if (event === 'done') {
            // ok
          }
        }
      }
    } catch (err) {
      if (pendingRender) { clearTimeout(pendingRender); pendingRender = null; }
      bubble.classList.remove('cursor-blink');
      bubble.classList.add('error');
      bubble.textContent = '出错了：' + (err.message || String(err));
      state.history.pop();  // remove the user msg so retry doesn't double up
      state.streaming = false;
      sendBtn.disabled = false;
      return;
    }

    bubble.classList.remove('cursor-blink');
    if (!assistantText) bubble.textContent = '(空回复)';
    else {
      if (pendingRender) { clearTimeout(pendingRender); pendingRender = null; }
      renderMarkdownInto(bubble, assistantText);
    }
    state.history.push({ role: 'assistant', content: assistantText });
    if (assistantText) saveTurn('assistant', assistantText);
    state.streaming = false;
    sendBtn.disabled = false;
  }

  function appendMessage(role, payload) {
    removeEmptyChat();
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    if (role === 'user') {
      if (payload.quote) {
        const q = document.createElement('div');
        q.className = 'quote';
        q.textContent = payload.quote;
        div.appendChild(q);
      }
      const t = document.createElement('div');
      t.textContent = payload.text;
      div.appendChild(t);
    } else {
      div.textContent = payload.text || '';
    }
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
    return div;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  // ---- Zoom (PDF only) ----
  function applyZoom() {
    const z = state.zoom;
    document.querySelectorAll('.pdf-page-wrapper').forEach((w) => {
      const baseW = parseFloat(w.dataset.baseW);
      const baseH = parseFloat(w.dataset.baseH);
      if (!baseW || !baseH) return;
      w.style.width = (baseW * z) + 'px';
      w.style.height = (baseH * z) + 'px';
      const inner = w.firstElementChild;
      if (inner) inner.style.transform = `scale(${z})`;
    });
    zoomLevelEl.textContent = Math.round(state.zoom * 100) + '%';
  }
  function setZoom(z) {
    state.zoom = Math.max(0.4, Math.min(3.0, z));
    applyZoom();
  }
  zoomInBtn.addEventListener('click', () => setZoom(state.zoom * 1.15));
  zoomOutBtn.addEventListener('click', () => setZoom(state.zoom / 1.15));
  zoomResetBtn.addEventListener('click', () => setZoom(1.0));
  leftPane.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    setZoom(state.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });

  // ---- Vision toggle ----
  if (visionToggle) {
    visionToggle.addEventListener('change', () => {
      state.sendImages = visionToggle.checked;
    });
  }

  // ---- Upload (PDF) — fully client-side: SHA256 + IndexedDB blob ----
  async function uploadPdfFile(file) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      alert('请选择 PDF 文件');
      return;
    }
    paperMeta.textContent = '处理中…';
    try {
      const buf = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buf);
      const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
      const id = 'upload-' + hex.slice(0, 12);
      // Persist the blob (idempotent — putting twice is fine)
      await idbPut(id, new Blob([buf], { type: 'application/pdf' }));
      const title = (file.name || '').replace(/\.pdf$/i, '') || id;
      arxivInput.value = id;
      await loadPaper(id, { title });
    } catch (err) {
      paperMeta.textContent = '';
      alert('处理失败：' + (err.message || String(err)));
    }
  }

  if (uploadBtn && uploadInput) {
    uploadBtn.addEventListener('click', () => uploadInput.click());
    uploadInput.addEventListener('change', () => {
      const f = uploadInput.files && uploadInput.files[0];
      uploadInput.value = '';
      if (f) uploadPdfFile(f);
    });
  }

  // Drag-drop on left pane
  let dragDepth = 0;
  function isPdfDrag(e) {
    if (!e.dataTransfer) return false;
    const items = e.dataTransfer.items;
    if (items && items.length) {
      for (const it of items) {
        if (it.kind === 'file') return true;
      }
    }
    const types = e.dataTransfer.types;
    return types && Array.prototype.indexOf.call(types, 'Files') !== -1;
  }
  leftPane.addEventListener('dragenter', (e) => {
    if (!isPdfDrag(e)) return;
    e.preventDefault();
    dragDepth++;
    leftPane.classList.add('dragover');
    dropHint.classList.remove('hidden');
  });
  leftPane.addEventListener('dragover', (e) => {
    if (!isPdfDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  leftPane.addEventListener('dragleave', (e) => {
    if (!isPdfDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      leftPane.classList.remove('dragover');
      dropHint.classList.add('hidden');
    }
  });
  leftPane.addEventListener('drop', (e) => {
    if (!isPdfDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    leftPane.classList.remove('dragover');
    dropHint.classList.add('hidden');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) uploadPdfFile(f);
  });
  // Prevent the browser from navigating away if user misses the drop zone
  window.addEventListener('dragover', (e) => { if (isPdfDrag(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => { if (isPdfDrag(e)) e.preventDefault(); });

  // ---- Library (browser-only) ----
  function registerInLibrary(id, title, authors) {
    libUpsert(id, title, authors);
  }
  function saveTurn(role, content) {
    if (!state.currentArxivId) return;
    libAppendTurn(state.currentArxivId, role, content);
  }

  function openLibrary() {
    libraryDrawer.classList.remove('hidden');
    libraryOverlay.classList.remove('hidden');
    libraryDrawer.setAttribute('aria-hidden', 'false');
    refreshLibraryList();
  }
  function closeLibrary() {
    libraryDrawer.classList.add('hidden');
    libraryOverlay.classList.add('hidden');
    libraryDrawer.setAttribute('aria-hidden', 'true');
  }
  libraryBtn.addEventListener('click', openLibrary);
  libraryClose.addEventListener('click', closeLibrary);
  libraryOverlay.addEventListener('click', closeLibrary);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !libraryDrawer.classList.contains('hidden')) closeLibrary();
  });

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const diffDays = Math.floor((now - d) / 86400000);
    if (diffDays < 7) return diffDays + ' 天前';
    return d.toLocaleDateString();
  }

  async function refreshLibraryList() {
    libraryList.innerHTML = '';
    const items = libList();
    if (!items.length) {
      libraryList.innerHTML = '<div class="lib-empty">还没有读过任何论文</div>';
      return;
    }
    items.forEach((it) => {
      const card = document.createElement('div');
      card.className = 'lib-card';
      card.dataset.id = it.id;
      card.innerHTML = `
        <div class="lib-card-main">
          <div class="lib-card-title">${escapeHtml(it.title || it.id)}</div>
          <div class="lib-card-meta">
            <span>${escapeHtml((it.authors || []).slice(0, 2).join(', ') || it.id)}</span>
            <span class="dot">·</span>
            <span>${it.turns} 轮对话</span>
            <span class="dot">·</span>
            <span>${fmtTime(it.updatedAt)}</span>
          </div>
        </div>
        <button class="lib-del" type="button" title="删除" aria-label="删除">🗑</button>
      `;
      card.querySelector('.lib-card-main').addEventListener('click', () => loadFromLibrary(it.id, it.title));
      card.querySelector('.lib-del').addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm('确定从记忆库移除这篇论文？对话历史将一并删除。')) return;
        libDelete(it.id);
        refreshLibraryList();
      });
      libraryList.appendChild(card);
    });
  }

  async function loadFromLibrary(id, title) {
    closeLibrary();
    arxivInput.value = id;
    await loadPaper(id, { title });
    // Restore conversation from localStorage
    const data = libGet(id);
    const hist = data && Array.isArray(data.history) ? data.history : [];
    if (!hist.length) return;
    state.history = hist.map(h => ({ role: h.role, content: h.content }));
    chatLog.innerHTML = '';
    hist.forEach((h) => {
      if (h.role === 'user') {
        const m = /^>\s+([\s\S]*?)\n\n([\s\S]*)$/.exec(h.content);
        if (m) appendMessage('user', { quote: m[1].trim(), text: m[2] });
        else appendMessage('user', { quote: '', text: h.content });
      } else {
        const div = document.createElement('div');
        div.className = 'msg assistant';
        renderMarkdownInto(div, h.content);
        chatLog.appendChild(div);
      }
    });
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  // ---- Resizable divider ----
  let dragging = false;
  divider.addEventListener('mousedown', (e) => {
    dragging = true;
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = main.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const clamped = Math.max(0.25, Math.min(0.85, ratio));
    leftPane.style.flex = `0 0 ${clamped * 100}%`;
  });
  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; document.body.style.cursor = ''; }
  });
})();
