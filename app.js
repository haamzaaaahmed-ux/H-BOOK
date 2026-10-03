import * as pdfjsLib from './vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

const DB_NAME = 'book-lens-local';
const DB_VERSION = 1;
const STORE_BOOKS = 'books';
const STORE_PAGES = 'pages';
const STORE_META = 'meta';
const SCAN_INTERVAL = 1500;

const $ = (selector) => document.querySelector(selector);
const state = {
  books: [],
  pages: [],
  stream: null,
  worker: null,
  scanBusy: false,
  lastQuery: '',
  lastResult: null,
  db: null,
};

const elements = {
  video: $('#camera'),
  fallback: $('#cameraFallback'),
  cameraHint: $('#cameraHint'),
  ocrStatus: $('#ocrStatus'),
  topStatus: $('#topStatus'),
  cameraResult: $('#cameraResult'),
  textQuery: $('#textQuery'),
  textResult: $('#textResult'),
  clearSearch: $('#clearSearch'),
  settingsButton: $('#settingsButton'),
  settingsDialog: $('#settingsDialog'),
  closeSettings: $('#closeSettings'),
  sheetFile: $('#sheetFile'),
  pdfFile: $('#pdfFile'),
  sheetInfo: $('#sheetInfo'),
  pdfInfo: $('#pdfInfo'),
  libraryStats: $('#libraryStats'),
  indexProgress: $('#indexProgress'),
  progressBar: $('#progressBar'),
  progressText: $('#progressText'),
  exportData: $('#exportData'),
  clearData: $('#clearData'),
};

const arabicMarks = /[\u064B-\u065F\u0670\u06D6-\u06ED]/g;
const punctuation = /[^\p{L}\p{N}]+/gu;

function normalize(text = '') {
  return String(text)
    .toLocaleLowerCase('ar')
    .normalize('NFKC')
    .replace(arabicMarks, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ـ/g, '')
    .replace(punctuation, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text = '') {
  return normalize(text).split(' ').filter((token) => token.length > 1);
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character]);
}

function setTopStatus(text, tone = 'normal') {
  elements.topStatus.textContent = text;
  elements.topStatus.dataset.tone = tone;
}

function updateStats() {
  const books = state.books.length;
  const pages = state.pages.length;
  elements.libraryStats.textContent = books ? `${books} كتاب · ${pages} صفحة مفهرسة` : 'لا توجد بيانات — ارفع الشيت والـPDF';
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_BOOKS)) db.createObjectStore(STORE_BOOKS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_PAGES)) db.createObjectStore(STORE_PAGES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbRequest(storeName, mode, action) {
  return new Promise((resolve, reject) => {
    if (!state.db) return reject(new Error('Database not ready'));
    const transaction = state.db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let request;
    try { request = action(store); } catch (error) { reject(error); return; }
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadLocalData() {
  try {
    state.db = await openDatabase();
    state.books = await dbRequest(STORE_BOOKS, 'readonly', (store) => store.getAll());
    state.pages = await dbRequest(STORE_PAGES, 'readonly', (store) => store.getAll());
  } catch (error) {
    console.warn('IndexedDB unavailable, using localStorage fallback', error);
    state.books = JSON.parse(localStorage.getItem('book-lens-books') || '[]');
    state.pages = JSON.parse(localStorage.getItem('book-lens-pages') || '[]');
  }
  updateStats();
}

async function replaceStore(storeName, values) {
  if (state.db) {
    await new Promise((resolve, reject) => {
      const transaction = state.db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      store.clear();
      values.forEach((value) => store.put(value));
    });
  } else {
    localStorage.setItem(storeName === STORE_BOOKS ? 'book-lens-books' : 'book-lens-pages', JSON.stringify(values));
  }
}

async function saveAll() {
  await replaceStore(STORE_BOOKS, state.books);
  await replaceStore(STORE_PAGES, state.pages);
  updateStats();
}

function fieldFromRow(row, names) {
  const entries = Object.entries(row || {});
  const normalized = entries.map(([key, value]) => [normalize(key), value]);
  const found = normalized.find(([key]) => names.some((name) => key === normalize(name) || key.includes(normalize(name))));
  return found?.[1] ?? '';
}

function buildBook(row, index) {
  const title = String(fieldFromRow(row, ['اسم الكتاب', 'الكتاب', 'العنوان', 'title', 'book', 'name']) || '').trim();
  const author = String(fieldFromRow(row, ['اسم المؤلف', 'المؤلف', 'author', 'writer']) || '').trim();
  const location = String(fieldFromRow(row, ['المكان', 'مكان الكتاب', 'الرف', 'shelf', 'location', 'place']) || '').trim();
  const code = String(fieldFromRow(row, ['ISBN', 'QR', 'الكود', 'code', 'isbn', 'qr']) || '').trim();
  const suppliedText = String(fieldFromRow(row, ['النص', 'نص الكتاب', 'الصفحة', 'text', 'content', 'page text']) || '').trim();
  const idSource = code || `${title}-${author}-${location}-${index}`;
  const id = `book-${normalize(idSource).replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 100) || crypto.randomUUID()}`;
  return { id, title, author, location, code, suppliedText, corpus: normalize([title, author, code, suppliedText].join(' ')) };
}

async function importSheet(file) {
  const buffer = await file.arrayBuffer();
  let rows;
  if (file.name.toLowerCase().endsWith('.csv')) {
    const text = new TextDecoder('utf-8').decode(buffer);
    rows = XLSX.utils.sheet_to_json(XLSX.read(text, { type: 'string' }).Sheets[XLSX.read(text, { type: 'string' }).SheetNames[0]], { defval: '' });
  } else {
    const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  }
  const books = rows.map(buildBook).filter((book) => book.title || book.code || book.author);
  if (!books.length) throw new Error('لم أجد أعمدة مفهومة. استخدم اسم الكتاب، المؤلف، والمكان.');
  const unique = new Map();
  books.forEach((book) => unique.set(book.id, book));
  state.books = [...unique.values()];
  await replaceStore(STORE_BOOKS, state.books);
  updateStats();
  elements.sheetInfo.textContent = `تم تحميل ${state.books.length} كتاب من ${file.name}`;
  setTopStatus(`${state.books.length} كتاب جاهز`, 'good');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      current[column] = Math.min(current[column - 1] + 1, previous[column] + 1, previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(0.98, Math.min(a.length, b.length) / Math.max(a.length, b.length) + 0.3);
  return Math.max(0, 1 - levenshtein(a, b) / Math.max(a.length, b.length));
}

function corpusForBook(book) {
  const pageText = state.pages.filter((page) => page.bookId === book.id).map((page) => page.text).join(' ');
  return normalize([book.corpus, pageText].join(' '));
}

function scoreCandidate(query, book) {
  const queryNorm = normalize(query);
  const queryTokens = tokens(query);
  if (!queryNorm || !queryTokens.length) return 0;
  const title = normalize(book.title);
  const author = normalize(book.author);
  const corpus = corpusForBook(book);
  let score = 0;
  if (title && queryNorm.includes(title)) score += 0.72;
  if (title && title.includes(queryNorm) && queryNorm.length > 3) score += 0.55;
  if (author && queryNorm.includes(author)) score += 0.46;
  const corpusTokens = new Set(tokens(corpus));
  let matched = 0;
  queryTokens.forEach((queryToken) => {
    if (corpusTokens.has(queryToken) || corpus.includes(queryToken)) { matched += 1; return; }
    let best = 0;
    for (const corpusToken of corpusTokens) {
      if (queryToken.length >= 3 && corpusToken.length >= 3) best = Math.max(best, similarity(queryToken, corpusToken));
    }
    if (best >= 0.72) matched += best * 0.85;
  });
  score += (matched / queryTokens.length) * 0.72;
  return Math.min(1, score);
}

function findMatches(query, minimum = 0.12) {
  return state.books.map((book) => ({ book, score: scoreCandidate(query, book) })).filter((match) => match.score >= minimum).sort((a, b) => b.score - a.score).slice(0, 3);
}

function resultHtml(match, source = 'نتيجة المطابقة') {
  if (!match) return '';
  const { book, score } = match;
  return `<div class="result-kicker">${escapeHtml(source)}</div><div class="result-title">${escapeHtml(book.title || 'كتاب بدون عنوان')}</div><div class="result-author">${escapeHtml(book.author || 'المؤلف غير مسجل')}</div><div class="result-location"><small>المكان</small><strong>${escapeHtml(book.location || 'غير محدد')}</strong></div><span class="result-confidence">ثقة تقريبية ${Math.round(Math.min(score, 1) * 100)}%</span>`;
}

function showTextResult(matches, query) {
  if (!query.trim()) { elements.textResult.hidden = true; return; }
  elements.textResult.hidden = false;
  if (!matches.length) {
    elements.textResult.className = 'text-result empty';
    elements.textResult.innerHTML = 'لم أجد تطابقًا قريبًا. جرّب لصق سطر أطول من التفريغ الصوتي أو ارفع ملفات المكتبة من الإعدادات.';
    return;
  }
  elements.textResult.className = 'text-result';
  elements.textResult.innerHTML = resultHtml(matches[0], 'أقرب كتاب للنص الملصوق');
}

function renderCameraResult(match, text) {
  elements.cameraResult.hidden = !match;
  if (match) {
    elements.cameraResult.innerHTML = resultHtml(match, 'تم التعرف على النص من الكاميرا');
    elements.ocrStatus.textContent = 'تم التعرف';
    elements.cameraResult.dataset.ocr = text.slice(0, 160);
  } else {
    elements.ocrStatus.textContent = 'قراءة مباشرة';
  }
}

function enhanceCanvas(sourceCanvas, mode = 'balanced') {
  const canvas = document.createElement('canvas');
  canvas.width = sourceCanvas.width;
  canvas.height = sourceCanvas.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(sourceCanvas, 0, 0);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = image.data;
  const contrast = mode === 'threshold' ? 2.15 : 1.45;
  const intercept = 128 * (1 - contrast);
  for (let index = 0; index < pixels.length; index += 4) {
    const gray = (pixels[index] * 0.299) + (pixels[index + 1] * 0.587) + (pixels[index + 2] * 0.114);
    let value = gray * contrast + intercept;
    if (mode === 'threshold') value = value > 151 ? 255 : 0;
    pixels[index] = value; pixels[index + 1] = value; pixels[index + 2] = value;
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

async function ensureOcr() {
  if (state.worker) return state.worker;
  if (!window.Tesseract) throw new Error('محرك OCR غير متاح');
  elements.ocrStatus.textContent = 'تحضير القراءة…';
  state.worker = await window.Tesseract.createWorker('ara+eng', 1, {
    workerPath: './ocr/worker.min.js',
    corePath: './ocr/core/tesseract-core-lstm.wasm.js',
    langPath: './ocr/lang/',
    workerBlobURL: false,
    gzip: false,
    logger: (event) => {
      if (event.status === 'recognizing text') elements.ocrStatus.textContent = `قراءة ${Math.round((event.progress || 0) * 100)}%`;
    },
  });
  await state.worker.setParameters({ preserve_interword_spaces: '1', tessedit_pageseg_mode: '11' });
  elements.ocrStatus.textContent = 'قراءة مباشرة';
  return state.worker;
}

async function recognizeCanvas(canvas) {
  const worker = await ensureOcr();
  const attempts = [];
  for (const mode of ['balanced', 'threshold']) {
    const prepared = enhanceCanvas(canvas, mode);
    const result = await worker.recognize(prepared);
    const text = result?.data?.text?.replace(/\s+/g, ' ').trim() || '';
    const confidence = Number(result?.data?.confidence || 0);
    if (text) attempts.push({ text, confidence });
  }
  attempts.sort((a, b) => (b.confidence + Math.min(b.text.length, 140) / 20) - (a.confidence + Math.min(a.text.length, 140) / 20));
  return attempts[0] || { text: '', confidence: 0 };
}

function captureVideoFrame() {
  const video = elements.video;
  if (!video.videoWidth || !video.videoHeight) return null;
  const canvas = document.createElement('canvas');
  const targetWidth = Math.min(1280, video.videoWidth);
  canvas.width = targetWidth;
  canvas.height = Math.round(targetWidth * video.videoHeight / video.videoWidth);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function scanVideoLoop() {
  if (!state.stream || state.scanBusy) return;
  state.scanBusy = true;
  try {
    const frame = captureVideoFrame();
    if (frame) {
      const recognition = await recognizeCanvas(frame);
      if (recognition.text.length >= 4) {
        const matches = findMatches(recognition.text, 0.18);
        renderCameraResult(matches[0], recognition.text);
        if (matches[0]) setTopStatus(`تم العثور على ${matches[0].book.title}`, 'good');
      }
    }
  } catch (error) {
    console.warn('Camera OCR scan failed', error);
    elements.ocrStatus.textContent = 'الكاميرا تعمل';
  } finally {
    state.scanBusy = false;
    if (state.stream) window.setTimeout(scanVideoLoop, SCAN_INTERVAL);
  }
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    elements.cameraHint.textContent = 'الكاميرا تحتاج فتح التطبيق من HTTPS أو تثبيته كتطبيق PWA';
    setTopStatus('الكاميرا تحتاج HTTPS', 'warn');
    return;
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    elements.video.srcObject = state.stream;
    await elements.video.play();
    elements.fallback.hidden = true;
    setTopStatus('الكاميرا جاهزة', 'good');
    scanVideoLoop();
  } catch (error) {
    elements.fallback.hidden = false;
    elements.cameraHint.textContent = error.name === 'NotAllowedError' ? 'اسمح باستخدام الكاميرا من إعدادات المتصفح ثم أعد فتح التطبيق' : 'تعذر تشغيل الكاميرا على هذا الجهاز';
    setTopStatus('الكاميرا متوقفة', 'warn');
  }
}

function findBookFromPageText(text, previousBook = null) {
  const matches = findMatches(text, 0.18);
  if (matches[0] && matches[0].score >= 0.28) return matches[0];
  return previousBook ? { book: previousBook, score: 0.22 } : null;
}

async function renderPdfPage(page) {
  const viewport = page.getViewport({ scale: 1.25 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return canvas;
}

async function importPdf(file) {
  if (!state.books.length) throw new Error('ارفع ملف Excel/CSV أولًا حتى يمكن ربط صفحات PDF بالكتب.');
  elements.indexProgress.hidden = false;
  elements.progressBar.style.width = '0%';
  const loadingTask = pdfjsLib.getDocument({ data: await file.arrayBuffer(), useWorkerFetch: true, isEvalSupported: true });
  const pdf = await loadingTask.promise;
  const pages = [];
  let currentBook = null;
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    let text = content.items.map((item) => item.str || '').join(' ').replace(/\s+/g, ' ').trim();
    if (text.length < 12) {
      const rendered = await renderPdfPage(page);
      const recognition = await recognizeCanvas(rendered);
      text = recognition.text;
    }
    const match = findBookFromPageText(text, currentBook);
    if (match) currentBook = match.book;
    pages.push({ id: `page-${pageNumber}`, pageNumber, text, bookId: currentBook?.id || null, score: match?.score || 0 });
    const progress = Math.round((pageNumber / pdf.numPages) * 100);
    elements.progressBar.style.width = `${progress}%`;
    elements.progressText.textContent = `فهرسة الصفحة ${pageNumber} من ${pdf.numPages}`;
  }
  state.pages = pages;
  await replaceStore(STORE_PAGES, state.pages);
  elements.pdfInfo.textContent = `تمت فهرسة ${pdf.numPages} صفحة من ${file.name}`;
  elements.indexProgress.hidden = true;
  updateStats();
  setTopStatus(`${pdf.numPages} صفحة مفهرسة`, 'good');
}

function exportBackup() {
  const backup = { version: 2, exportedAt: new Date().toISOString(), books: state.books, pages: state.pages };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `book-lens-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function clearAllData() {
  if (!window.confirm('سيتم حذف بيانات الكتب وفهرس الصفحات من هذا الجهاز. هل تريد المتابعة؟')) return;
  state.books = [];
  state.pages = [];
  await saveAll();
  elements.sheetInfo.textContent = 'لم يتم رفع ملف بعد';
  elements.pdfInfo.textContent = 'لم يتم رفع ملف بعد';
  elements.textResult.hidden = true;
  elements.cameraResult.hidden = true;
  setTopStatus('تم مسح البيانات', 'normal');
}

function wireEvents() {
  elements.settingsButton.addEventListener('click', () => elements.settingsDialog.showModal());
  elements.closeSettings.addEventListener('click', () => elements.settingsDialog.close());
  elements.settingsDialog.addEventListener('click', (event) => { if (event.target === elements.settingsDialog) elements.settingsDialog.close(); });
  elements.sheetFile.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try { elements.sheetInfo.textContent = 'جارٍ قراءة الملف…'; await importSheet(file); } catch (error) { elements.sheetInfo.textContent = `تعذر الرفع: ${error.message}`; }
    event.target.value = '';
  });
  elements.pdfFile.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try { elements.pdfInfo.textContent = 'جارٍ قراءة وفهرسة الصفحات…'; await importPdf(file); } catch (error) { elements.pdfInfo.textContent = `تعذر الفهرسة: ${error.message}`; elements.indexProgress.hidden = true; }
    event.target.value = '';
  });
  let searchTimer;
  elements.textQuery.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => showTextResult(findMatches(elements.textQuery.value, 0.12), elements.textQuery.value), 100);
  });
  elements.clearSearch.addEventListener('click', () => { elements.textQuery.value = ''; elements.textResult.hidden = true; elements.textQuery.focus(); });
  elements.exportData.addEventListener('click', exportBackup);
  elements.clearData.addEventListener('click', clearAllData);
}

async function init() {
  wireEvents();
  await loadLocalData();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('PWA worker unavailable', error));
  startCamera();
}

init();
