import './receipt-viewer.css';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_CANVAS_PIXELS = 8 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);
const imageExtensions = /\.(?:jpe?g|png|webp|gif|heic|heif)$/i;
let activeViewer = null;
let pdfLibrary = null;
let viewerSequence = 0;

const icon = path => `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
const icons = {
  close: icon('<path d="m6 6 12 12M6 18 18 6"/>'),
  previous: icon('<path d="m15 18-6-6 6-6"/>'),
  next: icon('<path d="m9 6 6 6-6 6"/>'),
  minus: icon('<path d="M5 12h14"/>'),
  plus: icon('<path d="M5 12h14M12 5v14"/>'),
  rotate: icon('<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/>'),
  download: icon('<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>'),
  file: icon('<path d="M14 3H5v18h14V8l-5-5ZM14 3v5h5M8 13h8M8 17h6"/>'),
};

/** Never interpret an active format (HTML/SVG/Office) as previewable media. */
export function receiptPreviewKind(attachment) {
  const mime = String(attachment?.mimeType || attachment?.type || '').toLowerCase().split(';')[0].trim();
  const name = String(attachment?.name || '');
  if (mime === 'application/pdf' && /\.pdf$/i.test(name)) return 'pdf';
  if (IMAGE_TYPES.has(mime) && imageExtensions.test(name)) return 'image';
  return 'unsupported';
}

async function pdfEngine() {
  pdfLibrary ||= Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ]).then(([pdf, worker]) => {
    pdf.GlobalWorkerOptions.workerSrc = worker.default;
    return pdf;
  }).catch(error => { pdfLibrary = null; throw error; });
  return pdfLibrary;
}

function isMediaSignature(bytes, kind, mime) {
  const ascii = (start, length) => String.fromCharCode(...bytes.slice(start, start + length));
  if (kind === 'pdf') return ascii(0, 5) === '%PDF-';
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/png') return [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v);
  if (mime === 'image/gif') return ['GIF87a', 'GIF89a'].includes(ascii(0, 6));
  if (mime === 'image/webp') return ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP';
  if (mime === 'image/heic' || mime === 'image/heif') return ascii(4, 4) === 'ftyp' && /(?:heic|heix|hevc|hevx|mif1|msf1)/.test(ascii(8, 44));
  return false;
}

/**
 * Displays original private receipts without replacing the expense editor.
 * The caller owns session identity and must dispose on logout/expiry/modal close.
 * loadAttachment performs the authenticated read; no file URL or contents persist.
 */
export function openReceiptViewer(options) {
  return createReceiptViewer(options);
}

/** Mounts the same private preview inside an editor without taking over focus. */
export function mountReceiptViewer(options) {
  if (!options?.parent?.append) throw new Error('El visor necesita un panel donde mostrarse.');
  return createReceiptViewer(options, true);
}

function createReceiptViewer({ attachments, initialIndex = 0, loadAttachment, parent = document.body, returnFocus = document.activeElement, isActive = () => true, onClose = () => {} }, embedded = false) {
  if (!Array.isArray(attachments) || !attachments.length || typeof loadAttachment !== 'function') throw new Error('No hay justificantes para mostrar.');
  if (!embedded) activeViewer?.dispose();
  if (!isActive()) throw new Error('Vuelve a entrar para ver el justificante.');

  const files = attachments.map(a => ({ ...a })), previousFocus = returnFocus;
  const titleId = `receipt-viewer-title-${++viewerSequence}`, privacyId = `receipt-viewer-privacy-${viewerSequence}`;
  const overlay = document.createElement('div');
  overlay.className = embedded ? 'receipt-viewer-embedded' : 'receipt-viewer-backdrop';
  overlay.dataset.receiptViewer = '';
  if (embedded) overlay.dataset.receiptViewerEmbedded = '';
  overlay.innerHTML = `<section class="receipt-viewer" role="${embedded ? 'region' : 'dialog'}" ${embedded ? '' : 'aria-modal="true"'} aria-labelledby="${titleId}" aria-describedby="${privacyId}">
    <header class="receipt-viewer-header"><div class="receipt-viewer-heading"><span class="receipt-viewer-eyebrow">JUSTIFICANTE ORIGINAL</span><h2 id="${titleId}"></h2><p id="${privacyId}">Vista privada · no se guarda en tu dispositivo</p></div>${embedded ? '' : `<button type="button" class="receipt-viewer-icon receipt-viewer-close" data-viewer="close" aria-label="Cerrar visor">${icons.close}</button>`}</header>
    <div class="receipt-viewer-files"><button type="button" class="receipt-viewer-icon" data-viewer="previous-file" aria-label="Justificante anterior">${icons.previous}</button><label class="receipt-viewer-select"><span>Archivo</span><select data-viewer="file" aria-label="Seleccionar justificante"></select></label><span class="receipt-viewer-file-count"></span><button type="button" class="receipt-viewer-icon" data-viewer="next-file" aria-label="Justificante siguiente">${icons.next}</button><button type="button" class="button secondary receipt-viewer-download" data-viewer="download">${icons.download}<span>Descargar original</span></button></div>
    <div class="receipt-viewer-tools"><div class="receipt-viewer-pages" hidden><button type="button" class="receipt-viewer-icon" data-viewer="previous-page" aria-label="Página anterior">${icons.previous}</button><label>Página <input type="number" data-viewer="page" min="1" step="1" value="1" aria-label="Página del PDF"></label><span data-viewer="pages"></span><button type="button" class="receipt-viewer-icon" data-viewer="next-page" aria-label="Página siguiente">${icons.next}</button></div><div class="receipt-viewer-image-label" hidden>Fotografía / imagen</div><div class="receipt-viewer-zoom"><button type="button" class="receipt-viewer-icon" data-viewer="zoom-out" aria-label="Alejar">${icons.minus}</button><output data-viewer="zoom" aria-label="Nivel de ampliación">100%</output><button type="button" class="receipt-viewer-icon" data-viewer="zoom-in" aria-label="Acercar">${icons.plus}</button><button type="button" class="receipt-viewer-fit" data-viewer="fit">Ajustar</button><button type="button" class="receipt-viewer-icon" data-viewer="rotate" aria-label="Girar 90 grados">${icons.rotate}</button></div></div>
    <div class="receipt-viewer-stage" tabindex="0" aria-label="Vista del justificante"><div class="receipt-viewer-document"></div></div>
    <footer class="receipt-viewer-footer"><span class="receipt-viewer-status" role="status" aria-live="polite"></span><span>El archivo original permanece intacto</span></footer>
  </section>`;
  const by = key => overlay.querySelector(`[data-viewer="${key}"]`);
  const section = overlay.querySelector('.receipt-viewer'), stage = overlay.querySelector('.receipt-viewer-stage');
  const documentArea = overlay.querySelector('.receipt-viewer-document'), title = overlay.querySelector('h2');
  const status = overlay.querySelector('.receipt-viewer-status'), fileCount = overlay.querySelector('.receipt-viewer-file-count');
  const tools = overlay.querySelector('.receipt-viewer-tools'), pages = overlay.querySelector('.receipt-viewer-pages');
  const imageLabel = overlay.querySelector('.receipt-viewer-image-label');
  const siblingStates = embedded ? [] : [...parent.children].map(element => ({ element, inert: element.inert }));
  siblingStates.forEach(({ element }) => { element.inert = true; });
  parent.append(overlay);
  if (!embedded) document.body.classList.add('receipt-viewer-open');

  let disposed = false, generation = 0, renderGeneration = 0;
  let currentIndex = Math.max(0, Math.min(files.length - 1, Math.floor(Number(initialIndex) || 0)));
  let originalBlob = null, loadPromise = null, imageUrl = '', image = null, imageHolder = null;
  let pdf = null, loadingTask = null, renderTask = null, canvas = null;
  let pageNumber = 1, zoom = 1, rotation = 0, ready = false, resizeTimer = null;
  const downloadUrls = new Set(), downloadTimers = new Set();
  const controller = {
    dispose,
    getSelectedIndex: () => currentIndex,
    select: index => {
      const next = Math.max(0, Math.min(files.length - 1, Math.floor(Number(index) || 0)));
      return next === currentIndex ? Promise.resolve() : showFile(next);
    },
  };
  if (!embedded) activeViewer = controller;

  function sessionIsActive() {
    if (disposed) return false;
    let allowed = false;
    try { allowed = Boolean(isActive()); } catch { /* A removed context cannot retain a preview. */ }
    if (!allowed) dispose();
    return allowed;
  }
  const current = token => sessionIsActive() && token === generation;
  const setStatus = message => { status.textContent = message; };
  function releaseDownloadUrls() {
    downloadTimers.forEach(clearTimeout); downloadTimers.clear();
    downloadUrls.forEach(url => URL.revokeObjectURL(url)); downloadUrls.clear();
  }
  function clearRender() {
    ++renderGeneration;
    try { renderTask?.cancel(); } catch { /* Already finished. */ }
    renderTask = null;
    if (canvas) { canvas.width = 0; canvas.height = 0; canvas = null; }
  }
  function clearFile() {
    ++generation; clearRender(); clearTimeout(resizeTimer); resizeTimer = null;
    const task = loadingTask, document = pdf;
    loadingTask = null; pdf = null;
    try { const result = task ? task.destroy() : document?.destroy(); result?.catch(() => {}); } catch { /* Worker is already closed. */ }
    if (image) { image.onload = null; image.onerror = null; image.removeAttribute('src'); }
    image = null; imageHolder = null;
    if (imageUrl) { URL.revokeObjectURL(imageUrl); imageUrl = ''; }
    releaseDownloadUrls(); originalBlob = null; loadPromise = null; ready = false;
    documentArea.replaceChildren(); documentArea.classList.remove('is-message');
  }
  function dispose() {
    if (disposed) return;
    disposed = true; clearFile(); resizeObserver?.disconnect();
    (embedded ? overlay : document).removeEventListener('keydown', keydown, true);
    document.removeEventListener('visibilitychange', checkSession);
    overlay.remove();
    siblingStates.forEach(({ element, inert }) => { if (element.isConnected) element.inert = inert; });
    if (!embedded) document.body.classList.remove('receipt-viewer-open');
    if (activeViewer === controller) activeViewer = null;
    if (!embedded && previousFocus?.isConnected && !previousFocus.closest('[inert]')) previousFocus.focus({ preventScroll: true });
    onClose();
  }
  function checkSession() { sessionIsActive(); }
  function keydown(event) {
    if (disposed) return;
    if (!sessionIsActive()) return;
    if (!embedded && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); dispose(); return; }
    if (!embedded && event.key === 'Tab') {
      event.stopImmediatePropagation();
      const elements = [...section.querySelectorAll('button,input,select,[tabindex="0"]')].filter(e => !e.disabled && !e.closest('[hidden]') && e.getClientRects().length);
      const first = elements[0], last = elements.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !section.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !section.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      return;
    }
    if (event.target.matches('input,select,textarea')) return;
    if (event.key === 'ArrowLeft' && currentIndex > 0) { event.preventDefault(); event.stopImmediatePropagation(); showFile(currentIndex - 1); }
    if (event.key === 'ArrowRight' && currentIndex < files.length - 1) { event.preventDefault(); event.stopImmediatePropagation(); showFile(currentIndex + 1); }
  }
  function message(heading, copy, { retry = false } = {}) {
    clearRender(); ready = false; syncTools();
    documentArea.classList.add('is-message');
    documentArea.innerHTML = `<div class="receipt-viewer-message">${icons.file}<h3></h3><p></p>${retry ? '<button type="button" class="button secondary">Volver a intentar</button>' : ''}</div>`;
    documentArea.querySelector('h3').textContent = heading;
    documentArea.querySelector('p').textContent = copy;
    if (retry) documentArea.querySelector('button').onclick = () => showFile(currentIndex);
  }
  function syncTools() {
    const kind = receiptPreviewKind(files[currentIndex]);
    pages.hidden = kind !== 'pdf'; imageLabel.hidden = kind !== 'image';
    tools.hidden = kind === 'unsupported';
    ['zoom-out', 'zoom-in', 'fit', 'rotate'].forEach(key => { by(key).disabled = !ready; });
    by('zoom-out').disabled = !ready || zoom <= .5;
    by('zoom-in').disabled = !ready || zoom >= 3;
    by('zoom').value = Math.round(zoom * 100) + '%';
    by('previous-page').disabled = !ready || !pdf || pageNumber <= 1;
    by('next-page').disabled = !ready || !pdf || pageNumber >= pdf.numPages;
    by('page').disabled = !ready || !pdf;
    by('page').value = String(pageNumber); by('page').max = String(pdf?.numPages || 1);
    by('pages').textContent = 'de ' + (pdf?.numPages || '…');
  }
  async function original(token) {
    if (!current(token)) return null;
    if (originalBlob) return originalBlob;
    const attachment = files[currentIndex];
    loadPromise ||= Promise.resolve().then(() => loadAttachment(attachment));
    const pendingRead = loadPromise;
    let blob;
    try { blob = await pendingRead; }
    catch (error) {
      if (!disposed && token === generation && loadPromise === pendingRead) loadPromise = null;
      throw error;
    }
    if (!current(token)) return null;
    if (!(blob instanceof Blob) || !blob.size || blob.size > MAX_FILE_BYTES || (attachment.size && attachment.size !== blob.size)) throw new Error('El archivo está incompleto o supera el tamaño permitido.');
    originalBlob = blob;
    return blob;
  }
  async function showFile(index) {
    if (!sessionIsActive()) return;
    clearFile(); currentIndex = index;
    const token = generation, attachment = files[currentIndex], kind = receiptPreviewKind(attachment);
    pageNumber = 1; zoom = 1; rotation = 0;
    title.textContent = attachment.name || 'Justificante'; title.title = title.textContent;
    by('file').value = String(currentIndex); fileCount.textContent = `${currentIndex + 1} de ${files.length}`;
    by('previous-file').disabled = currentIndex === 0; by('next-file').disabled = currentIndex === files.length - 1;
    by('download').disabled = false; stage.scrollTo(0, 0); syncTools();
    if (kind === 'unsupported') {
      setStatus('Original disponible para descargar');
      message('Este formato necesita su propia aplicación', 'Puedes ver aquí los PDF y las fotos. Para abrir este documento de Office u otro formato, descarga el original.');
      return;
    }
    documentArea.innerHTML = '<div class="receipt-viewer-loading"><i aria-hidden="true"></i><p>Abriendo justificante…</p></div>';
    setStatus('Cargando archivo privado…');
    try {
      const blob = await original(token);
      if (!blob || !current(token)) return;
      const mime = String(attachment.mimeType || attachment.type).toLowerCase().split(';')[0].trim();
      const signature = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
      if (!current(token)) return;
      if (!isMediaSignature(signature, kind, mime)) throw new Error('No se puede reconocer el contenido de este archivo.');
      if (kind === 'image') { showImage(blob, mime, token); return; }
      const engine = await pdfEngine();
      if (!current(token)) return;
      const data = new Uint8Array(await blob.arrayBuffer());
      if (!current(token)) return;
      const standards = new URL(`${import.meta.env.BASE_URL}pdfjs/standard_fonts/`, document.baseURI).href;
      const task = engine.getDocument({ data, enableXfa: false, isEvalSupported: false, useWasm: false, useWorkerFetch: false, disableFontFace: true, useSystemFonts: false, standardFontDataUrl: standards, maxImageSize: 24 * 1024 * 1024, disableAutoFetch: true, disableStream: true });
      loadingTask = task;
      task.onPassword = (updatePassword, reason) => passwordPrompt(updatePassword, reason === engine.PasswordResponses.INCORRECT_PASSWORD, token);
      const pdfDocument = await task.promise;
      if (!current(token)) { pdfDocument.destroy().catch(() => {}); return; }
      pdf = pdfDocument; ready = true; syncTools();
      await renderPDF(token);
    } catch (error) {
      if (!current(token) || error?.name === 'RenderingCancelledException') return;
      setStatus('No se pudo mostrar el justificante');
      message('No hemos podido abrir la vista', error?.message?.includes('incompleto') ? error.message : 'Puedes volver a intentarlo o descargar el archivo original para abrirlo.', { retry: true });
    }
  }
  function passwordPrompt(updatePassword, incorrect, token) {
    if (!current(token)) return;
    ready = false; syncTools(); setStatus('PDF protegido con contraseña');
    documentArea.classList.add('is-message');
    documentArea.innerHTML = '<form class="receipt-viewer-password"><h3>Este PDF tiene contraseña</h3><p>Introduce la contraseña del documento para verlo. Solo se usa aquí y no se guarda.</p><label>Contraseña del PDF<input type="password" autocomplete="off" required aria-label="Contraseña del PDF"></label><small role="status"></small><button type="submit" class="button primary">Abrir PDF</button></form>';
    const form = documentArea.querySelector('form'), input = form.querySelector('input');
    form.querySelector('small').textContent = incorrect ? 'La contraseña no es correcta. Inténtalo de nuevo.' : '';
    form.onsubmit = event => {
      event.preventDefault();
      if (!current(token)) return;
      const password = input.value; input.value = '';
      if (!password) return;
      documentArea.classList.remove('is-message');
      documentArea.innerHTML = '<div class="receipt-viewer-loading"><i aria-hidden="true"></i><p>Abriendo PDF…</p></div>';
      setStatus('Abriendo PDF…'); updatePassword(password);
    };
    if (!embedded) input.focus({ preventScroll: true });
  }
  function showImage(blob, mime, token) {
    imageUrl = URL.createObjectURL(new Blob([blob], { type: mime }));
    image = document.createElement('img'); image.alt = 'Justificante: ' + files[currentIndex].name;
    image.decoding = 'async'; image.draggable = false;
    imageHolder = document.createElement('div'); imageHolder.className = 'receipt-viewer-image'; imageHolder.append(image);
    image.onload = () => {
      if (!current(token)) return;
      ready = true; documentArea.replaceChildren(imageHolder); syncTools(); sizeImage(); setStatus('Foto original · usa + para ver los detalles');
    };
    image.onerror = () => {
      if (!current(token)) return;
      if (image) { image.onerror = null; image.removeAttribute('src'); }
      if (imageUrl) { URL.revokeObjectURL(imageUrl); imageUrl = ''; }
      setStatus('Este navegador no puede mostrar la imagen');
      message('No se puede mostrar esta imagen', /heic|heif/.test(mime) ? 'Este navegador no admite este archivo HEIC. Puedes descargar el original o añadir una copia JPEG del justificante.' : 'Puedes descargar el archivo original para abrirlo en otra aplicación.');
    };
    image.src = imageUrl;
  }
  function sizeImage() {
    if (!image?.naturalWidth || !ready) return;
    const swapped = rotation % 180 !== 0, width = swapped ? image.naturalHeight : image.naturalWidth, height = swapped ? image.naturalWidth : image.naturalHeight;
    const fit = Math.min(Math.max(100, stage.clientWidth - 48) / width, Math.max(100, stage.clientHeight - 48) / height);
    const scale = fit * zoom;
    imageHolder.style.width = `${Math.round(width * scale)}px`; imageHolder.style.height = `${Math.round(height * scale)}px`;
    image.style.width = `${Math.round(image.naturalWidth * scale)}px`; image.style.height = `${Math.round(image.naturalHeight * scale)}px`;
    image.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
  }
  async function renderPDF(token = generation) {
    if (!pdf || !current(token)) return;
    clearRender(); const turn = renderGeneration, activePDF = pdf;
    setStatus('Mostrando página…');
    try {
      const page = await activePDF.getPage(pageNumber);
      if (!current(token) || turn !== renderGeneration || pdf !== activePDF) return;
      const angle = (page.rotate + rotation) % 360, plain = page.getViewport({ scale: 1, rotation: angle });
      const fit = Math.max(100, Math.min(stage.clientWidth - 48, 900)) / plain.width;
      const viewport = page.getViewport({ scale: fit * zoom, rotation: angle });
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
      const nextCanvas = document.createElement('canvas');
      nextCanvas.width = Math.max(1, Math.floor(viewport.width * pixelRatio)); nextCanvas.height = Math.max(1, Math.floor(viewport.height * pixelRatio));
      nextCanvas.style.width = `${viewport.width}px`; nextCanvas.style.height = `${viewport.height}px`;
      nextCanvas.setAttribute('role', 'img'); nextCanvas.setAttribute('aria-label', `Página ${pageNumber} de ${activePDF.numPages} del justificante ${files[currentIndex].name}`);
      canvas = nextCanvas; documentArea.classList.remove('is-message'); documentArea.replaceChildren(nextCanvas);
      renderTask = page.render({ canvas: nextCanvas, viewport, transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0], background: '#fff' });
      await renderTask.promise;
      if (!current(token) || turn !== renderGeneration) return;
      renderTask = null; setStatus(`Página ${pageNumber} de ${activePDF.numPages} · PDF original`);
    } catch (error) {
      if (!current(token) || turn !== renderGeneration || error?.name === 'RenderingCancelledException') return;
      setStatus('No se pudo mostrar esta página');
      message('No se puede mostrar esta página', 'Puedes descargar el PDF original para abrirlo en otra aplicación.', { retry: true });
    }
  }
  function updateView() {
    if (!sessionIsActive() || !ready) return;
    syncTools(); if (pdf) renderPDF(); else sizeImage();
  }
  async function download() {
    if (!sessionIsActive()) return;
    const token = generation, attachment = files[currentIndex], button = by('download');
    button.disabled = true;
    try {
      const blob = await original(token);
      if (!blob || !current(token)) return;
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      downloadUrls.add(url); a.href = url; a.download = attachment.name || 'justificante'; a.rel = 'noopener'; a.click();
      const timer = setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.delete(url); downloadTimers.delete(timer); }, 10000);
      downloadTimers.add(timer); setStatus('Descarga del original iniciada');
    } catch {
      if (current(token)) setStatus('No se pudo descargar. Vuelve a intentarlo.');
    } finally { if (current(token)) button.disabled = false; }
  }

  files.forEach((attachment, i) => { const option = document.createElement('option'); option.value = String(i); option.textContent = `${i + 1}. ${attachment.name || 'Justificante'}`; by('file').append(option); });
  if (!embedded) by('close').onclick = dispose;
  by('previous-file').onclick = () => showFile(currentIndex - 1);
  by('next-file').onclick = () => showFile(currentIndex + 1);
  by('file').onchange = event => showFile(Number(event.target.value));
  by('download').onclick = download;
  function changePage(next) {
    if (!pdf || !ready || !sessionIsActive()) return;
    pageNumber = Math.max(1, Math.min(pdf.numPages, Math.round(Number(next)) || 1));
    stage.scrollTo(0, 0); syncTools(); renderPDF();
  }
  by('previous-page').onclick = () => changePage(pageNumber - 1);
  by('next-page').onclick = () => changePage(pageNumber + 1);
  by('page').onchange = event => changePage(event.target.value);
  by('zoom-out').onclick = () => { zoom = Math.max(.5, Math.round((zoom - .25) * 100) / 100); updateView(); };
  by('zoom-in').onclick = () => { zoom = Math.min(3, Math.round((zoom + .25) * 100) / 100); updateView(); };
  by('fit').onclick = () => { zoom = 1; stage.scrollTo(0, 0); updateView(); };
  by('rotate').onclick = () => { rotation = (rotation + 90) % 360; updateView(); };
  if (!embedded) overlay.onclick = event => { if (event.target === overlay) dispose(); };
  (embedded ? overlay : document).addEventListener('keydown', keydown, true);
  document.addEventListener('visibilitychange', checkSession);
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (!disposed && ready) updateView(); }, 120);
  }) : null;
  resizeObserver?.observe(stage);
  if (!embedded) by('close').focus({ preventScroll: true });
  showFile(currentIndex);
  return controller;
}
