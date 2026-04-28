// State
let authToken = null;
let currentBook = null;
let currentPage = 0;
let totalPages = 0;
let isLoading = false;
let sessionId = crypto.randomUUID();
let spreadMode = false;

const GRID = 6;
let noiseInterval = null;
let progressTimer = null;

// --- Poison canvas extraction methods ---
const _origToDataURL = HTMLCanvasElement.prototype.toDataURL;
const _origToBlob = HTMLCanvasElement.prototype.toBlob;
const _origGetImageData = CanvasRenderingContext2D.prototype.getImageData;

HTMLCanvasElement.prototype.toDataURL = function () {
    if (this.closest('#tile-grid') || this.id === 'noise-overlay') {
        console.warn('%c[DRM] Canvas export blocked', 'color:red;font-weight:bold');
        return 'data:image/png;base64,';
    }
    return _origToDataURL.apply(this, arguments);
};
HTMLCanvasElement.prototype.toBlob = function (cb) {
    if (this.closest('#tile-grid') || this.id === 'noise-overlay') {
        if (cb) cb(null);
        return;
    }
    return _origToBlob.apply(this, arguments);
};
CanvasRenderingContext2D.prototype.getImageData = function () {
    if (this.canvas.closest('#tile-grid')) {
        return new ImageData(1, 1);
    }
    return _origGetImageData.apply(this, arguments);
};
const _origReadPixels = WebGLRenderingContext.prototype.readPixels;
WebGLRenderingContext.prototype.readPixels = function () {
    if (this.canvas.closest('#tile-grid')) return;
    return _origReadPixels.apply(this, arguments);
};
if (window.WebGL2RenderingContext) {
    const _origRP2 = WebGL2RenderingContext.prototype.readPixels;
    WebGL2RenderingContext.prototype.readPixels = function () {
        if (this.canvas.closest('#tile-grid')) return;
        return _origRP2.apply(this, arguments);
    };
}

// --- Init: check for session ---
(async function init() {
    authToken = sessionStorage.getItem('drm_token');
    const email = sessionStorage.getItem('drm_email');

    if (!authToken) {
        document.getElementById('no-session-screen').style.display = 'block';
        return;
    }

    // Validate token
    try {
        const res = await apiFetch('/api/books');
        if (!res.ok) throw new Error();
        const booksList = await res.json();
        if (email) {
            document.getElementById('user-email').textContent = email;
        }

        // Direct open if redirected from shop purchase
        const openBookId = sessionStorage.getItem('drm_open_book');
        sessionStorage.removeItem('drm_open_book');
        if (openBookId) {
            const target = booksList.find(b => b.book_id === openBookId);
            if (target) {
                openBook(target.book_id, target.page_count, target.current_page);
                return;
            }
        }
        showBookList();
    } catch {
        sessionStorage.removeItem('drm_token');
        sessionStorage.removeItem('drm_email');
        document.getElementById('no-session-screen').style.display = 'block';
    }
})();

// --- API Helper ---
function apiFetch(url, opts = {}) {
    opts.headers = opts.headers || {};
    opts.headers['Authorization'] = `Bearer ${authToken}`;
    return fetch(url, opts);
}

// --- Book List ---
async function showBookList() {
    if (noiseInterval) { clearInterval(noiseInterval); noiseInterval = null; }
    if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
    document.getElementById('tile-grid').innerHTML = '';
    document.getElementById('no-session-screen').style.display = 'none';
    document.getElementById('reader-screen').style.display = 'none';
    document.getElementById('book-list-screen').style.display = 'block';

    const res = await apiFetch('/api/books');
    const books = await res.json();
    const list = document.getElementById('book-list');
    list.innerHTML = '';

    if (books.length === 0) {
        list.innerHTML = '<p style="color:#888">Du hast noch keine Bücher. Kaufe ein Buch im Shop um es hier zu lesen.</p>';
        return;
    }

    for (const b of books) {
        const div = document.createElement('div');
        div.className = 'book-item';
        const progress = b.current_page > 0
            ? `Seite ${b.current_page + 1}/${b.page_count}`
            : `${b.page_count} Seiten`;
        div.innerHTML = `
            <div>
                <span class="title">${esc(b.title || b.filename)}</span>
                ${b.current_page > 0 ? '<span class="badge">Weiterlesen</span>' : ''}
            </div>
            <span class="pages">${progress}</span>
        `;
        div.onclick = () => openBook(b.book_id, b.page_count, b.current_page);
        list.appendChild(div);
    }
}

function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

// --- Reader ---
async function openBook(bookId, pageCount, startPage) {
    currentBook = bookId;
    currentPage = startPage || 0;
    totalPages = pageCount;
    document.getElementById('book-list-screen').style.display = 'none';
    document.getElementById('reader-screen').style.display = 'flex';
    await renderPage();
}

function toggleSpread() {
    spreadMode = !spreadMode;
    const btn = document.getElementById('btn-spread');
    btn.textContent = spreadMode ? 'Einzelseite' : 'Doppelseite';
    // Snap to even page in spread mode
    if (spreadMode && currentPage % 2 !== 0 && currentPage > 0) {
        currentPage--;
    }
    renderPage();
}

async function renderSinglePage(pageNum, grid) {
    const tokenRes = await apiFetch(`/api/book/${currentBook}/page/${pageNum}/tokens`);
    const { tokens, decoys } = await tokenRes.json();

    grid.style.gridTemplateColumns = `repeat(${GRID}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${GRID}, 1fr)`;

    const tiles = [];
    for (let r = 0; r < GRID; r++)
        for (let c = 0; c < GRID; c++)
            tiles.push({ r, c, token: tokens[`${r}_${c}`] });

    const domOrder = [...tiles].sort(() => Math.random() - 0.5);
    const canvasMap = {};
    for (const tile of domOrder) {
        const canvas = document.createElement('canvas');
        canvas.style.gridRow = (tile.r + 1).toString();
        canvas.style.gridColumn = (tile.c + 1).toString();
        grid.appendChild(canvas);
        canvasMap[`${tile.r}_${tile.c}`] = canvas;
    }

    for (const d of decoys) apiFetch(`/api/decoy/${d}`).catch(() => {});

    const fetchOrder = [...tiles].sort(() => Math.random() - 0.5);
    const promises = fetchOrder.map(async (tile, i) => {
        await sleep(30 + Math.random() * 120 + i * 20);
        const url = `/api/book/${currentBook}/page/${pageNum}/tile/${tile.r}/${tile.c}?token=${tile.token}`;
        const res = await apiFetch(url);
        if (!res.ok) return;
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const img = new Image();
        return new Promise(resolve => {
            img.onload = () => {
                const canvas = canvasMap[`${tile.r}_${tile.c}`];
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                applyInvisibleWatermark(ctx, canvas.width, canvas.height, tile.r, tile.c);
                URL.revokeObjectURL(blobUrl);
                img.src = '';
                resolve();
            };
            img.onerror = resolve;
            img.src = blobUrl;
        });
    });

    await Promise.all(promises);
}

async function renderPage() {
    if (isLoading) return;
    isLoading = true;
    const loading = document.getElementById('loading-indicator');
    loading.style.display = 'block';

    updateNav();

    const container = document.getElementById('tile-grid');
    container.innerHTML = '';

    if (spreadMode) {
        container.classList.add('spread');
        const leftGrid = document.createElement('div');
        leftGrid.className = 'spread-page';
        leftGrid.style.display = 'grid';
        container.appendChild(leftGrid);

        const renderJobs = [renderSinglePage(currentPage, leftGrid)];

        const rightPage = currentPage + 1;
        if (rightPage < totalPages) {
            const rightGrid = document.createElement('div');
            rightGrid.className = 'spread-page';
            rightGrid.style.display = 'grid';
            container.appendChild(rightGrid);
            renderJobs.push(renderSinglePage(rightPage, rightGrid));
        }

        await Promise.all(renderJobs);
    } else {
        container.classList.remove('spread');
        container.style.gridTemplateColumns = `repeat(${GRID}, 1fr)`;
        container.style.gridTemplateRows = `repeat(${GRID}, 1fr)`;
        await renderSinglePage(currentPage, container);
    }

    fitGrid();
    drawNoise();
    if (noiseInterval) clearInterval(noiseInterval);
    noiseInterval = setInterval(drawNoise, 1500);

    saveProgress();

    loading.style.display = 'none';
    isLoading = false;
}

function saveProgress() {
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = setTimeout(() => {
        apiFetch(`/api/book/${currentBook}/progress`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ page: currentPage }),
        }).catch(() => {});
    }, 500);
}

// Invisible watermark
function applyInvisibleWatermark(ctx, w, h, row, col) {
    const seed = hashCode(sessionId + ':' + row + ':' + col);
    const rng = mulberry32(seed);
    const imgData = _origGetImageData.call(ctx, 0, 0, w, h);
    const d = imgData.data;
    for (let i = 0; i < 20; i++) {
        const px = Math.floor(rng() * (w * h));
        const idx = px * 4;
        const channel = Math.floor(rng() * 3);
        const delta = rng() > 0.5 ? 1 : -1;
        d[idx + channel] = Math.max(0, Math.min(255, d[idx + channel] + delta));
    }
    ctx.putImageData(imgData, 0, 0);
}

function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
}

function mulberry32(a) {
    return function () {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function fitGrid() {
    const container = document.getElementById('tile-grid');
    const viewport = document.getElementById('reader-viewport');
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight - 10;

    if (spreadMode) {
        const pages = container.querySelectorAll('.spread-page');
        const first = pages[0]?.querySelector('canvas');
        if (!first || !first.width) return;
        const pageW = first.width * GRID;
        const pageH = first.height * GRID;
        const totalW = pageW * pages.length;
        const scale = Math.min(vw / totalW, vh / pageH, 1);
        const scaledPageW = pageW * scale;
        const scaledH = pageH * scale;
        pages.forEach(p => {
            p.style.width = scaledPageW + 'px';
            p.style.height = scaledH + 'px';
        });
        container.style.width = (scaledPageW * pages.length) + 'px';
        container.style.height = scaledH + 'px';
        const noise = document.getElementById('noise-overlay');
        noise.width = Math.round(scaledPageW * pages.length);
        noise.height = Math.round(scaledH);
        noise.style.width = container.style.width;
        noise.style.height = container.style.height;
        const copyGuard = document.getElementById('copy-guard');
        copyGuard.style.width = container.style.width;
        copyGuard.style.height = container.style.height;
    } else {
        const first = container.querySelector('canvas');
        if (!first || !first.width) return;
        const totalW = first.width * GRID;
        const totalH = first.height * GRID;
        const scale = Math.min(vw / totalW, vh / totalH, 1);
        container.style.width = (totalW * scale) + 'px';
        container.style.height = (totalH * scale) + 'px';
        const noise = document.getElementById('noise-overlay');
        noise.width = Math.round(totalW * scale);
        noise.height = Math.round(totalH * scale);
        noise.style.width = container.style.width;
        noise.style.height = container.style.height;
        const copyGuard = document.getElementById('copy-guard');
        copyGuard.style.width = container.style.width;
        copyGuard.style.height = container.style.height;
    }
}

function drawNoise() {
    const canvas = document.getElementById('noise-overlay');
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(canvas.width, canvas.height);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
        const v = Math.random() * 30;
        data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 8;
    }
    ctx.putImageData(imageData, 0, 0);
}

function updateNav() {
    if (spreadMode) {
        const rightPage = Math.min(currentPage + 1, totalPages - 1);
        document.getElementById('page-info').textContent =
            currentPage === rightPage
                ? `Seite ${currentPage + 1} / ${totalPages}`
                : `Seite ${currentPage + 1}–${rightPage + 1} / ${totalPages}`;
    } else {
        document.getElementById('page-info').textContent = `Seite ${currentPage + 1} / ${totalPages}`;
    }
    document.getElementById('btn-prev').disabled = currentPage <= 0;
    document.getElementById('btn-next').disabled = spreadMode
        ? currentPage + 2 >= totalPages
        : currentPage >= totalPages - 1;
}

async function nextPage() {
    const step = spreadMode ? 2 : 1;
    if (currentPage + step < totalPages) { currentPage += step; await renderPage(); }
}
async function prevPage() {
    const step = spreadMode ? 2 : 1;
    if (currentPage - step >= 0) { currentPage -= step; }
    else { currentPage = 0; }
    await renderPage();
}

function toggleFullscreen() {
    const reader = document.getElementById('reader-screen');
    if (!document.fullscreenElement) reader.requestFullscreen().catch(() => {});
    else document.exitFullscreen();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function clearAllTiles() {
    document.querySelectorAll('#tile-grid canvas, .spread-page canvas').forEach(c => { c.width = c.width; });
}

// --- Anti-copy ---
document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('dragstart', e => e.preventDefault());

(function devtoolsGuard() {
    const threshold = 160;
    setInterval(() => {
        const w = window.outerWidth - window.innerWidth > threshold;
        const h = window.outerHeight - window.innerHeight > threshold;
        if (w || h) clearAllTiles();
    }, 1000);
})();

document.addEventListener('visibilitychange', () => {
    const grid = document.getElementById('tile-grid');
    grid.style.filter = document.hidden ? 'blur(30px) brightness(0.3)' : '';
});
window.addEventListener('blur', () => {
    document.getElementById('tile-grid').style.filter = 'blur(30px) brightness(0.3)';
});
window.addEventListener('focus', () => {
    document.getElementById('tile-grid').style.filter = '';
});

document.addEventListener('keyup', e => {
    if (e.key === 'PrintScreen') {
        clearAllTiles();
        setTimeout(() => renderPage(), 500);
    }
});

document.addEventListener('keydown', e => {
    if (document.getElementById('reader-screen').style.display === 'flex') {
        if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); nextPage(); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); prevPage(); }
        if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'p' || e.key === 'u')) e.preventDefault();
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && 'iIjJcC'.includes(e.key)) e.preventDefault();
    if (e.key === 'F12') e.preventDefault();
});

window.addEventListener('resize', () => {
    if (document.getElementById('reader-screen').style.display === 'flex') {
        fitGrid();
        drawNoise();
    }
});
