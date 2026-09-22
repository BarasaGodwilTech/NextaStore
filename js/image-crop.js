/**
 * A single, reusable "confirm your photo" step used everywhere an image is
 * uploaded (store logo/banner, product photos). Shows the picked file in a
 * fixed-aspect crop frame the user can drag/zoom, then resolves to a
 * cropped Blob only once they confirm — nothing is ever saved straight off
 * disk without the seller seeing and approving exactly what will be shown.
 *
 * Usage:
 *   const cropped = await window.NextaImageCrop.open(file, { aspect: 1, title: 'Crop your logo' });
 *   if (!cropped) return; // user cancelled
 *   // cropped is a Blob (image/jpeg) — pass it anywhere a File/Blob is accepted,
 *   // e.g. straight into app.optimizeImage(cropped, {...}).
 */
(function () {
    function open(file, opts = {}) {
        const aspect = opts.aspect || 1;
        const title = opts.title || 'Adjust your photo';
        const outWidth = opts.outWidth || (aspect >= 1 ? 1200 : Math.round(1200 * aspect));
        const outHeight = Math.round(outWidth / aspect);
        const format = opts.preservePng ? 'image/png' : 'image/jpeg';

        return new Promise((resolve) => {
            if (!file || !file.type || !file.type.startsWith('image/')) {
                resolve(null);
                return;
            }

            const objectUrl = URL.createObjectURL(file);
            const img = new Image();

            img.onload = () => {
                const cleanupAndResolve = (value) => {
                    URL.revokeObjectURL(objectUrl);
                    overlay.remove();
                    document.removeEventListener('keydown', onKeydown);
                    resolve(value);
                };

                // ---- build the modal ----
                const overlay = document.createElement('div');
                overlay.className = 'image-crop-overlay';
                overlay.innerHTML = `
                    <div class="image-crop-panel" role="dialog" aria-modal="true" aria-label="${title}">
                        <div class="image-crop-header">
                            <h3>${title}</h3>
                            <button type="button" class="image-crop-close" aria-label="Cancel">&times;</button>
                        </div>
                        <div class="image-crop-stage-wrap">
                            <div class="image-crop-stage"></div>
                        </div>
                        <div class="image-crop-controls">
                            <i class="fas fa-magnifying-glass-minus"></i>
                            <input type="range" min="1" max="3" step="0.01" value="1" class="image-crop-zoom">
                            <i class="fas fa-magnifying-glass-plus"></i>
                        </div>
                        <div class="image-crop-actions">
                            <button type="button" class="btn btn-outline image-crop-cancel">Cancel</button>
                            <button type="button" class="btn btn-primary image-crop-confirm"><i class="fas fa-check"></i> Use this photo</button>
                        </div>
                    </div>
                `;
                document.body.appendChild(overlay);

                const stageWrap = overlay.querySelector('.image-crop-stage-wrap');
                const stage = overlay.querySelector('.image-crop-stage');
                const zoomInput = overlay.querySelector('.image-crop-zoom');

                // Stage sizing: as wide as the wrapper allows, height derived
                // from the target aspect, capped so it never overflows a
                // small/mobile viewport.
                const maxW = Math.min(stageWrap.clientWidth || 480, 480);
                const maxH = Math.min(window.innerHeight * 0.55, maxW / aspect);
                let stageW = maxW;
                let stageH = stageW / aspect;
                if (stageH > maxH) { stageH = maxH; stageW = stageH * aspect; }
                stage.style.width = `${stageW}px`;
                stage.style.height = `${stageH}px`;

                const naturalW = img.naturalWidth;
                const naturalH = img.naturalHeight;
                const coverScale = Math.max(stageW / naturalW, stageH / naturalH);

                const state = { zoom: 1, offsetX: 0, offsetY: 0 };

                const imgEl = document.createElement('img');
                imgEl.src = objectUrl;
                imgEl.draggable = false;
                stage.appendChild(imgEl);

                function clampAndApply() {
                    const scale = coverScale * state.zoom;
                    const dispW = naturalW * scale;
                    const dispH = naturalH * scale;
                    state.offsetX = Math.min(0, Math.max(stageW - dispW, state.offsetX));
                    state.offsetY = Math.min(0, Math.max(stageH - dispH, state.offsetY));
                    imgEl.style.width = `${dispW}px`;
                    imgEl.style.height = `${dispH}px`;
                    imgEl.style.transform = `translate(${state.offsetX}px, ${state.offsetY}px)`;
                }

                // Center the image in the frame on first paint.
                const initScale = coverScale;
                state.offsetX = (stageW - naturalW * initScale) / 2;
                state.offsetY = (stageH - naturalH * initScale) / 2;
                clampAndApply();

                // ---- drag to reposition ----
                let dragging = false, startX = 0, startY = 0, startOffX = 0, startOffY = 0;
                const onPointerDown = (e) => {
                    dragging = true;
                    const p = e.touches ? e.touches[0] : e;
                    startX = p.clientX; startY = p.clientY;
                    startOffX = state.offsetX; startOffY = state.offsetY;
                    stage.classList.add('dragging');
                };
                const onPointerMove = (e) => {
                    if (!dragging) return;
                    const p = e.touches ? e.touches[0] : e;
                    state.offsetX = startOffX + (p.clientX - startX);
                    state.offsetY = startOffY + (p.clientY - startY);
                    clampAndApply();
                    e.preventDefault();
                };
                const onPointerUp = () => { dragging = false; stage.classList.remove('dragging'); };

                stage.addEventListener('mousedown', onPointerDown);
                window.addEventListener('mousemove', onPointerMove);
                window.addEventListener('mouseup', onPointerUp);
                stage.addEventListener('touchstart', onPointerDown, { passive: true });
                window.addEventListener('touchmove', onPointerMove, { passive: false });
                window.addEventListener('touchend', onPointerUp);

                zoomInput.addEventListener('input', () => {
                    state.zoom = Number(zoomInput.value);
                    clampAndApply();
                });

                function onKeydown(e) {
                    if (e.key === 'Escape') cleanupAndResolve(null);
                }
                document.addEventListener('keydown', onKeydown);

                overlay.querySelector('.image-crop-close').addEventListener('click', () => cleanupAndResolve(null));
                overlay.querySelector('.image-crop-cancel').addEventListener('click', () => cleanupAndResolve(null));
                overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanupAndResolve(null); });

                overlay.querySelector('.image-crop-confirm').addEventListener('click', () => {
                    const scale = coverScale * state.zoom;
                    const cropX = -state.offsetX / scale;
                    const cropY = -state.offsetY / scale;
                    const cropW = stageW / scale;
                    const cropH = stageH / scale;

                    const canvas = document.createElement('canvas');
                    canvas.width = outWidth;
                    canvas.height = outHeight;
                    const ctx = canvas.getContext('2d');
                    if (format === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, outWidth, outHeight); }
                    ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, outWidth, outHeight);
                    canvas.toBlob((blob) => {
                        if (!blob) { cleanupAndResolve(null); return; }
                        cleanupAndResolve(blob);
                    }, format, 0.9);
                });
            };

            img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(null); };
            img.src = objectUrl;
        });
    }

    window.NextaImageCrop = { open };
})();
