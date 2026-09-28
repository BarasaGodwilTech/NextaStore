class SubscriptionManager {
    constructor() {
        this.data = null;
        this.allowedMonths = [1, 3, 6, 12, 24];
        this.planTiles = [];
        this.init().catch(() => {}).then(() => window.NextaLoader && window.NextaLoader.ready('page'));
    }

    async init() {
        this.renderPlanPicker();
        document.getElementById('subMonths')?.addEventListener('change', () => this.syncAmount());
        this.syncAmount();
        await this.load();
        document.getElementById('subPaymentForm')?.addEventListener('submit', e => this.submitPayment(e));
    }

    async load() {
        try {
            const res = await app.apiRequest('/subscription');
            this.data = res.data || {};
            this.renderPlanPicker();
            this.renderStatus();
            this.renderGoal();
            this.renderBadgeLadder();
            this.renderPayNumbers(this.data.paymentInfo || {});
            this.renderHistory();
            this.syncAmount(true);
        } catch (err) {
            app.showAlert(err.message, 'error');
            const card = document.getElementById('subStatusCard');
            if (card) card.innerHTML = '<div class="subscription-status-pill status-expired"><i class="fas fa-triangle-exclamation"></i> Could not load</div><h1>We could not confirm your Seller Pass status</h1><p>Refresh the page before sending money so you are not working from old information.</p>';
        }
    }

    expectedAmount() {
        const months = Number(document.getElementById('subMonths')?.value || 1);
        return Number(this.data?.priceUgx || 20000) * months;
    }

    recommendedMonths() {
        const remaining = Number(this.data?.monthsToNextBadge || 0);
        // Only pre-select a plan when the seller is already paid and part-way
        // toward a badge (the exact remaining months genuinely helps them).
        // A brand-new or expired seller gets no default nudge toward 6
        // months — the cheapest tile (1 month) is selected until they
        // actively tap one themselves, or use the "Choose 6 months" button
        // in the goal card, which still jumps to 6 on request.
        if (this.data?.isPaid && remaining > 0 && this.allowedMonths.includes(remaining)) return remaining;
        return 1;
    }

    // ---- Step 1: visual plan tiles, kept in sync with the real (hidden) <select> ----
    renderPlanPicker() {
        const el = document.getElementById('subPlanPicker');
        const select = document.getElementById('subMonths');
        if (!el || !select) return;
        const price = Number(this.data?.priceUgx || 20000);
        const badgeFor = m => (
            m === 6 ? { label: 'Verified', tone: 'verified', icon: 'fa-circle-check' } :
            m === 12 ? { label: 'Gold', tone: 'gold', icon: 'fa-crown' } :
            m === 24 ? { label: 'Platinum', tone: 'platinum', icon: 'fa-gem' } : null
        );
        el.innerHTML = this.allowedMonths.map(m => {
            const badge = badgeFor(m);
            return `<button type="button" class="plan-tile" data-months="${m}" aria-pressed="false">
                <span class="plan-tile-check"><i class="fas fa-check"></i></span>
                <span class="plan-tile-months">${m}<small>${m === 1 ? 'month' : 'months'}</small></span>
                <span class="plan-tile-price">${app.formatCurrency(price * m)}</span>
                ${badge ? `<span class="plan-tile-badge tone-${badge.tone}"><i class="fas ${badge.icon}"></i>${badge.label}</span>` : '<span class="plan-tile-badge tone-none">No badge</span>'}
            </button>`;
        }).join('');
        this.planTiles = [...el.querySelectorAll('.plan-tile')];
        this.planTiles.forEach(tile => tile.addEventListener('click', () => {
            select.value = tile.dataset.months;
            select.dispatchEvent(new Event('change'));
        }));
        this.syncPlanPicker();
    }

    syncPlanPicker() {
        const select = document.getElementById('subMonths');
        if (!select) return;
        this.planTiles.forEach(tile => {
            const active = tile.dataset.months === select.value;
            tile.classList.toggle('is-selected', active);
            tile.setAttribute('aria-pressed', String(active));
        });
    }

    syncAmount(afterLoad = false) {
        const monthsEl = document.getElementById('subMonths');
        const amountEl = document.getElementById('subAmount');
        if (!monthsEl || !amountEl) return;

        if (afterLoad && this.data) {
            const recommended = this.recommendedMonths();
            if ([...monthsEl.options].some(o => Number(o.value) === recommended)) monthsEl.value = String(recommended);
        }
        const months = Number(monthsEl.value || 1);
        const amount = this.expectedAmount();
        amountEl.value = amount;

        const totalEl = document.getElementById('coverageCallout');
        if (totalEl) {
            const badgeAt = { 6: 'Verified Seller', 12: 'Gold Partner', 24: 'Platinum Partner' }[months];
            totalEl.innerHTML = `<span class="total-figure"><small>Total to send</small><strong>${app.formatCurrency(amount)}</strong></span>` +
                (badgeAt
                    ? `<span class="total-unlock"><i class="fas fa-award"></i> Unlocks ${badgeAt}</span>`
                    : `<span class="total-unlock total-unlock-muted"><i class="fas fa-circle-info"></i> ${months} month${months === 1 ? '' : 's'} added</span>`);
        }
        this.syncPlanPicker();
        // The dial string embeds the exact amount for the chosen coverage —
        // keep it in sync whenever months/amount change, not just when the
        // network is (re)selected.
        const currentMethod = document.getElementById('subMethod')?.value;
        if (currentMethod) this.renderDialInstructions(currentMethod);
        window.proofScanner?.renderResult();
    }

    renderStatus() {
        const card = document.getElementById('subStatusCard');
        const d = this.data || {};
        const price = Number(d.priceUgx || 20000);
        const priceLabel = document.getElementById('subPriceLabel');
        if (priceLabel) priceLabel.textContent = app.formatCurrency(price);

        if (d.status === 'trial') {
            card.innerHTML = `<div class="status-card-main"><span class="subscription-status-pill status-trial"><i class="fas fa-gift"></i> Free trial</span><h2>Your store is live</h2><p>${d.daysLeft} day${d.daysLeft === 1 ? '' : 's'} left — pay before it ends to stay active.</p></div><div class="status-card-side"><strong>${d.daysLeft}</strong><span>days left</span></div>`;
        } else if (d.status === 'active') {
            const badge = d.badge ? `<span class="inline-badge inline-badge--${app.escapeHtml(d.badge.tone)}"><i class="fas ${app.escapeHtml(d.badge.icon)}"></i>${app.escapeHtml(d.badge.label)}</span>` : '<span class="threshold-pill"><i class="fas fa-lock"></i> Badge starts at 6 months</span>';
            card.innerHTML = `<div class="status-card-main"><span class="subscription-status-pill status-active"><i class="fas fa-circle-check"></i> Paid Seller Pass</span><h2>${badge}</h2><p>Active until <strong>${app.formatDate(d.subscriptionPaidUntil)}</strong> · ${d.daysLeft} day${d.daysLeft === 1 ? '' : 's'} left.</p></div><div class="status-card-side"><strong>${d.commitmentMonths || 0}</strong><span>months covered</span></div>`;
        } else {
            card.innerHTML = `<div class="status-card-main"><span class="subscription-status-pill status-expired"><i class="fas fa-hourglass-end"></i> Seller Pass ended</span><h2>Renew to reopen your store</h2><p>Choose a coverage period below. <strong>6 months or more earns a badge.</strong></p></div><div class="status-card-side"><i class="fas fa-arrow-rotate-right"></i><span>Ready to renew</span></div>`;
        }
    }

    renderGoal() {
        const el = document.getElementById('subGoalCard');
        const d = this.data || {};
        if (!el) return;
        const months = Number(d.commitmentMonths || 0);
        const jumpTo = (value) => {
            const select = document.getElementById('subMonths');
            if (!select) return;
            select.value = String(value);
            this.syncAmount();
            document.getElementById('subPlanPicker')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        };
        if (d.badge) {
            const next = d.nextBadgeMonths;
            if (next) {
                el.innerHTML = `<div class="goal-icon"><i class="fas ${app.escapeHtml(d.badge.icon)}"></i></div><div><strong>${app.escapeHtml(d.badge.label)} unlocked</strong><p>Add ${d.monthsToNextBadge} more month${d.monthsToNextBadge === 1 ? '' : 's'} to reach ${next === 12 ? 'Gold Partner' : 'Platinum Partner'}.</p></div>`;
            } else {
                el.innerHTML = `<div class="goal-icon"><i class="fas fa-gem"></i></div><div><strong>Top badge reached</strong><p>Extra payments only extend your end date.</p></div>`;
            }
        } else if (d.isPaid && months > 0) {
            el.innerHTML = `<div class="goal-icon goal-icon-muted"><i class="fas fa-bullseye"></i></div><div><strong>${months} month${months === 1 ? '' : 's'} covered</strong><p>Add ${d.monthsToNextBadge} more month${d.monthsToNextBadge === 1 ? '' : 's'} to reach Verified Seller.</p></div><button type="button" class="btn btn-outline btn-sm" id="goalAddButton">Add ${d.monthsToNextBadge} month${d.monthsToNextBadge === 1 ? '' : 's'}</button>`;
            document.getElementById('goalAddButton')?.addEventListener('click', () => jumpTo(d.monthsToNextBadge));
        } else {
            el.innerHTML = `<div class="goal-icon goal-icon-muted"><i class="fas fa-flag-checkered"></i></div><div><strong>First badge at 6 months</strong><p>A 6-month approved payment unlocks Verified Seller.</p></div><button type="button" class="btn btn-primary btn-sm" id="goalStartButton">Choose 6 months</button>`;
            document.getElementById('goalStartButton')?.addEventListener('click', () => jumpTo(6));
        }
    }

    // Turns the badge rules into one glanceable progress track instead of three static cards.
    renderBadgeLadder() {
        const el = document.getElementById('subscriptionBadgeLadder');
        if (!el) return;
        const months = Number(this.data?.commitmentMonths || 0);
        const tiers = [
            { at: 0, label: 'Start', short: '', icon: 'fa-flag', tone: 'start' },
            { at: 6, label: 'Verified', short: '6 mo', icon: 'fa-circle-check', tone: 'verified' },
            { at: 12, label: 'Gold', short: '12 mo', icon: 'fa-crown', tone: 'gold' },
            { at: 24, label: 'Platinum', short: '24 mo', icon: 'fa-gem', tone: 'platinum' },
        ];
        const fillPct = Math.max(0, Math.min(100, (months / 24) * 100));
        let markedNext = false;
        const nodes = tiers.map(t => {
            const reached = months >= t.at;
            let cls = 'badge-node';
            if (reached) cls += ' is-reached';
            else if (!markedNext) { cls += ' is-next'; markedNext = true; }
            return `<div class="${cls}"><span class="badge-node-icon tone-${t.tone}"><i class="fas ${t.icon}"></i></span><span class="badge-node-label">${t.label}${t.short ? `<small>${t.short}</small>` : ''}</span></div>`;
        }).join('');
        el.innerHTML = `<div class="badge-track-bar"><div class="badge-track-fill" style="width:${fillPct}%"></div></div><div class="badge-track-nodes">${nodes}</div>`;
    }

    // Cards are deliberately NOT pre-selected (the hidden <select>'s first
    // option is now blank, not "mtnMomo") — a seller must actively tap one,
    // rather than silently sending to whichever method happened to be first
    // in the markup. Each card shows a radio dot, an explicit "Send to"
    // label on the number (so it reads as an account to pay into, not just
    // a stray string of digits), and — once chosen — the admin-set dial
    // steps for that network via renderDialInstructions().
    renderPayNumbers(info) {
        const el = document.getElementById('subPayNumbers');
        const rows = [];
        const add = (method, cls, icon, label, code, name) => {
            if (!code) return;
            rows.push(`<button type="button" class="subscription-pay-number ${cls}" data-pay-method="${method}" aria-pressed="false">
                <span class="pay-number-radio" aria-hidden="true"></span>
                <span class="pay-number-main"><i class="fas ${icon}"></i><span><strong>${app.escapeHtml(label)}</strong><small>${app.escapeHtml(name || 'NextaStore')}</small></span></span>
                <span class="pay-number-code"><small>Send to</small><code>${app.escapeHtml(code)}</code></span>
            </button>`);
        };
        add('mtnMomo', 'pay-mtn', 'fa-mobile-screen-button', 'MTN MoMo', info.mtnMomoCode, info.mtnMomoName);
        add('airtelMoney', 'pay-airtel', 'fa-mobile-screen-button', 'Airtel Money', info.airtelMoneyCode, info.airtelMoneyName);
        el.innerHTML = rows.length ? rows.join('') : '<div class="subscription-pay-empty"><i class="fas fa-circle-info"></i><span>Mobile-money payment details have not been configured yet. Contact NextaStore before sending money.</span></div>';
        this.dialInstructions = { mtnMomo: info.mtnMomoInstructions || '', airtelMoney: info.airtelMoneyInstructions || '' };
        this.paymentCodes = { mtnMomo: info.mtnMomoCode || '', airtelMoney: info.airtelMoneyCode || '' };
        const mark = (btn, active) => { btn.classList.toggle('is-selected', active); btn.setAttribute('aria-pressed', String(active)); };
        el.querySelectorAll('[data-pay-method]').forEach(btn => btn.addEventListener('click', () => {
            const method = btn.dataset.payMethod;
            const select = document.getElementById('subMethod');
            if (select) select.value = method;
            el.querySelectorAll('[data-pay-method]').forEach(x => mark(x, x === btn));
            this.renderDialInstructions(method);
        }));
        const current = document.getElementById('subMethod')?.value;
        el.querySelectorAll('[data-pay-method]').forEach(x => mark(x, x.dataset.payMethod === current));
        this.renderDialInstructions(current);
    }

    // Shows how to pay for whichever network is currently chosen. Nothing
    // chosen yet → hidden. Once a network IS chosen, this always renders
    // something: an admin's own dial-instructions text if they've set one
    // (platform settings), otherwise a generated fallback built from the
    // real merchant code and the real amount for the coverage currently
    // selected — so a seller is never left staring at a blank box just
    // because nobody has typed custom copy into the admin panel yet.
    renderDialInstructions(method) {
        const el = document.getElementById('subPayDial');
        if (!el) return;
        if (!method) { el.hidden = true; el.innerHTML = ''; return; }
        const label = method === 'mtnMomo' ? 'MTN MoMo' : 'Airtel Money';
        const custom = (this.dialInstructions?.[method] || '').trim();
        const code = this.paymentCodes?.[method] || '';
        const amount = this.expectedAmount ? this.expectedAmount() : 0;
        const star = method === 'mtnMomo' ? '*165*3*' : '*185*9*';
        const fallback = code
            ? `Dial ${star}${code}*${amount || '<amount>'}#, enter your PIN, then confirm.`
            : `Open your ${label} menu, choose Send Money, enter the number above and the amount shown, then confirm with your PIN.`;
        const text = custom || fallback;
        el.hidden = false;
        el.innerHTML = `<i class="fas fa-phone"></i><div><strong>How to pay with ${app.escapeHtml(label)}</strong><p>${app.escapeHtml(text)}</p></div>`;
    }

    renderHistory() {
        const el = document.getElementById('subHistory');
        const payments = Array.isArray(this.data?.payments) ? this.data.payments : [];
        if (!payments.length) {
            el.innerHTML = '<div class="subscription-history-empty"><i class="fas fa-receipt"></i><strong>No payment submitted yet</strong><span>Your first mobile-money payment will appear here after you submit the transaction ID.</span></div>';
            return;
        }
        const iconFor = s => s === 'approved' ? 'fa-circle-check' : s === 'rejected' ? 'fa-circle-xmark' : 'fa-clock';
        el.innerHTML = payments.map(p => {
            const method = p.method === 'mtnMomo' ? 'MTN MoMo' : 'Airtel Money';
            const status = String(p.status || 'pending').toLowerCase();
            const title = status === 'approved' ? 'Approved' : status === 'rejected' ? 'Not confirmed' : 'Pending';
            return `<article class="subscription-payment-row"><span class="payment-status-icon ${app.escapeHtml(status)}"><i class="fas ${iconFor(status)}"></i></span><div class="subscription-payment-main"><strong>${app.formatCurrency(p.amount)} · ${p.periodMonths} month${p.periodMonths === 1 ? '' : 's'}</strong><small>${method} · ${app.escapeHtml(p.reference)} · ${app.escapeHtml(app.formatDate(p.submittedAt))}</small>${p.note ? `<em>${app.escapeHtml(p.note)}</em>` : ''}</div><span class="subscription-payment-status ${app.escapeHtml(status)}">${title}</span></article>`;
        }).join('');
    }

    async submitPayment(e) {
        e.preventDefault();
        const btn = document.getElementById('subSubmitBtn');
        const amount = Number(document.getElementById('subAmount').value);
        const method = document.getElementById('subMethod').value;
        const reference = document.getElementById('subReference').value.trim();
        const periodMonths = Number(document.getElementById('subMonths').value);
        const expected = this.expectedAmount();

        if (!method) return app.showAlert('Please choose MTN MoMo or Airtel Money above before sending.', 'warning');
        if (!amount || !reference) return app.showAlert('Please enter the transaction ID from your mobile-money SMS.', 'warning');
        if (amount !== expected) { app.showAlert(`The correct amount is ${app.formatCurrency(expected)} for ${periodMonths} month${periodMonths === 1 ? '' : 's'}.`, 'warning'); this.syncAmount(); return; }
        if (!this.data?.paymentInfo?.[method + 'Code']) return app.showAlert('That mobile-money payment option is not currently configured. Please contact NextaStore.', 'warning');

        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending…';
        try {
            await app.apiRequest('/subscription/payments', { method: 'POST', body: JSON.stringify({ amount, method, reference, periodMonths }) });
            app.showAlert('Payment submitted. We will check the transaction before adding the months or badge.', 'success');
            document.getElementById('subPaymentForm').reset();
            const chip = document.getElementById('scanProofChip');
            if (chip) { chip.hidden = true; chip.innerHTML = ''; }
            window.proofScanner?.forgetScan();
            this.syncAmount();
            await this.load();
        } catch (err) { app.showAlert(err.message, 'error'); }
        finally { btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> Send for checking'; }
    }
}

// Lets a seller attach a photo of their MTN/Airtel confirmation SMS instead
// of typing the transaction ID by hand. Runs OCR entirely in the browser
// (Tesseract.js, loaded on demand) — no image is ever sent to NextaStore's
// servers, it is only read locally to pre-fill the two fields below, and the
// result always stays editable because photos of small phone screens can be
// misread.
class ProofScanner {
    constructor(manager) {
        this.manager = manager;
        this.worker = null;
        this.workerPromise = null;
        this.maxPhotos = 2;
        this.photos = [];
        this.extracted = { amount: null, reference: null };
        this.extracting = false;
        this.bind();
    }

    bind() {
        document.getElementById('subScanBtn')?.addEventListener('click', () => this.open());
        document.getElementById('scanProofChip')?.addEventListener('click', () => this.open());
        document.getElementById('proofModalClose')?.addEventListener('click', () => this.close());
        document.getElementById('proofManualLink')?.addEventListener('click', () => this.close());
        document.getElementById('proofModalOverlay')?.addEventListener('click', e => { if (e.target.id === 'proofModalOverlay') this.close(); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && !document.getElementById('proofModalOverlay')?.hidden) this.close(); });

        document.getElementById('proofFileInput')?.addEventListener('change', e => {
            this.handleFiles([...e.target.files]);
            e.target.value = ''; // lets the same file be re-picked later (e.g. after removing it)
        });
        document.getElementById('proofExtractBtn')?.addEventListener('click', () => this.runExtraction());
        document.getElementById('proofUseBtn')?.addEventListener('click', () => this.useDetails());
        document.getElementById('proofRefInput')?.addEventListener('input', e => {
            document.getElementById('proofUseBtn').disabled = !e.target.value.trim();
        });
    }

    open() {
        const overlay = document.getElementById('proofModalOverlay');
        if (!overlay) return;
        overlay.hidden = false;
        document.body.classList.add('modal-open');
        this.resetSteps();
    }

    close() {
        const overlay = document.getElementById('proofModalOverlay');
        if (overlay) overlay.hidden = true;
        document.body.classList.remove('modal-open');
    }

    forgetScan() {
        this.photos.forEach(p => { if (p.url) URL.revokeObjectURL(p.url); });
        this.photos = [];
        this.extracted = { amount: null, reference: null };
    }

    resetSteps() {
        this.forgetScan();
        this.extracting = false;
        const fileInput = document.getElementById('proofFileInput');
        if (fileInput) fileInput.value = '';
        document.getElementById('proofResult').hidden = true;
        document.getElementById('proofScanStatus').hidden = true;
        const emptyNote = document.getElementById('proofEmptyNote');
        if (emptyNote) emptyNote.hidden = true;
        const refInput = document.getElementById('proofRefInput');
        if (refInput) refInput.value = '';
        const useBtn = document.getElementById('proofUseBtn');
        if (useBtn) useBtn.disabled = true;
        this.renderPreviews();
    }

    // ---- Attaching a photo (camera or gallery) only queues it in the
    // preview strip — nothing is read yet. Add a second photo first (up to
    // `maxPhotos`) if the amount and transaction ID land on different
    // screens, then a single tap on "Extract details" reads whatever is
    // queued together, so a two-photo pair is always combined into one
    // result instead of each photo racing off to be scanned on its own. ----
    handleFiles(files) {
        const room = this.maxPhotos - this.photos.length;
        if (room <= 0) { app.showAlert(`You can attach up to ${this.maxPhotos} photos.`, 'warning'); return; }
        const imageFiles = files.filter(f => f.type.startsWith('image/')).slice(0, room);
        if (imageFiles.length < files.length) app.showAlert(`You can attach up to ${this.maxPhotos} photos.`, 'warning');
        if (!imageFiles.length) return;

        for (const file of imageFiles) {
            this.photos.push({
                id: `p${Date.now()}${Math.random().toString(36).slice(2, 7)}`,
                url: URL.createObjectURL(file),
                text: '', status: 'pending', error: null
            });
        }
        const emptyNote = document.getElementById('proofEmptyNote');
        if (emptyNote) emptyNote.hidden = true;
        this.renderPreviews();
    }

    // ---- Reads every not-yet-scanned queued photo in turn, then recomputes
    // the combined result once they're all done. That's what makes a
    // two-photo pair get read "together" — the amount from one screen and
    // the ID from another both land in the same result — instead of each
    // photo's scan overwriting or racing the other's. ----
    async runExtraction() {
        const pending = this.photos.filter(p => p.status === 'pending');
        if (!pending.length) return;

        this.extracting = true;
        this.setExtractBusy(true);
        const emptyNote = document.getElementById('proofEmptyNote');
        if (emptyNote) emptyNote.hidden = true;

        for (const photo of pending) {
            photo.status = 'reading';
            this.renderPreviews();
            try {
                const img = await this.loadImage(photo.url);
                const canvas = this.preprocess(img);
                const worker = await this.ensureWorker();
                const { data: { text } } = await worker.recognize(canvas);
                const clean = (text || '').trim();
                photo.text = clean;
                if (clean) {
                    photo.status = 'done';
                } else {
                    photo.status = 'empty';
                    photo.error = 'Nothing readable found';
                }
            } catch (err) {
                photo.status = 'error';
                photo.error = err.message || 'Could not read this photo.';
            }
            this.renderPreviews();
        }

        const statusBar = document.getElementById('proofScanStatus');
        if (statusBar) statusBar.hidden = true;
        this.extracting = false;
        this.recomputeExtraction();
        this.setExtractBusy(false);
    }

    setExtractBusy(isBusy) {
        const btn = document.getElementById('proofExtractBtn');
        if (!btn) return;
        btn.disabled = isBusy;
        btn.innerHTML = isBusy
            ? '<i class="fas fa-spinner fa-spin"></i> Reading…'
            : this.photos.length > 1
                ? '<i class="fas fa-wand-magic-sparkles"></i> Extract from both photos'
                : '<i class="fas fa-wand-magic-sparkles"></i> Extract details';
    }

    // Recomputed from every scanned photo's text each time (rather than
    // patched incrementally) so removing a bad photo cleanly drops whatever
    // it had contributed instead of leaving stale amount/reference behind.
    recomputeExtraction() {
        const extracted = { amount: null, reference: null };
        for (const photo of this.photos) {
            if (photo.status !== 'done') continue;
            if (extracted.amount == null) {
                const amt = this.extractAmount(photo.text);
                if (amt) extracted.amount = amt;
            }
            if (!extracted.reference) {
                const ref = this.extractReference(photo.text);
                if (ref) extracted.reference = ref;
            }
        }
        this.extracted = extracted;
        this.renderResult();

        // Once every queued photo has finished reading (none still pending
        // or in progress) and nothing usable came out of any of them,
        // say so plainly instead of leaving the person staring at a modal
        // that just quietly did nothing.
        const emptyNote = document.getElementById('proofEmptyNote');
        if (!emptyNote) return;
        const allSettled = this.photos.length > 0 && this.photos.every(p => p.status === 'done' || p.status === 'empty' || p.status === 'error');
        const foundNothing = !extracted.amount && !extracted.reference;
        if (allSettled && foundNothing) {
            const noneReadable = this.photos.every(p => p.status !== 'done');
            emptyNote.hidden = false;
            emptyNote.querySelector('span').textContent = noneReadable
                ? "We couldn't read anything in that photo — try a clearer, well-lit shot, or type the details in yourself."
                : "We read the photo but couldn't find an amount or transaction ID in it — check it's the right screen, or type the ID in yourself.";
        } else {
            emptyNote.hidden = true;
        }
    }

    removePhoto(id) {
        const idx = this.photos.findIndex(p => p.id === id);
        if (idx === -1) return;
        const [removed] = this.photos.splice(idx, 1);
        if (removed.url) URL.revokeObjectURL(removed.url);
        this.renderPreviews();
        this.recomputeExtraction();
    }

    renderPreviews() {
        const wrap = document.getElementById('proofPreviews');
        const title = document.getElementById('proofDropzoneTitle');
        const hint = document.getElementById('proofDropzoneHint');
        const uploadArea = document.getElementById('proofUploadArea');
        const extractBtn = document.getElementById('proofExtractBtn');
        const hasPhotos = this.photos.length > 0;
        if (title) title.textContent = hasPhotos ? 'Add another photo' : 'Take a photo or choose a screenshot';
        if (hint) hint.textContent = hasPhotos ? "Only if the amount and ID are on a different screen" : "Make sure the amount and ID are visible — add a second photo if they're on different screens";
        if (uploadArea) uploadArea.hidden = this.photos.length >= this.maxPhotos;
        if (extractBtn) {
            extractBtn.hidden = !hasPhotos;
            if (!this.extracting) this.setExtractBusy(false);
        }
        if (!wrap) return;
        if (!hasPhotos) { wrap.hidden = true; wrap.innerHTML = ''; return; }
        wrap.hidden = false;
        wrap.innerHTML = this.photos.map(p => {
            const statusHtml = p.status === 'reading'
                ? '<span class="proof-preview-status"><i class="fas fa-spinner fa-spin"></i> Reading…</span>'
                : p.status === 'error'
                    ? `<span class="proof-preview-status is-error"><i class="fas fa-triangle-exclamation"></i> ${app.escapeHtml(p.error || 'Could not read')}</span>`
                    : p.status === 'empty'
                        ? `<span class="proof-preview-status is-warn"><i class="fas fa-triangle-exclamation"></i> ${app.escapeHtml(p.error || 'Nothing readable found')}</span>`
                        : p.status === 'done'
                            ? '<span class="proof-preview-status is-done"><i class="fas fa-check"></i> Scanned</span>'
                            : '<span class="proof-preview-status is-pending"><i class="fas fa-clock"></i> Ready to scan</span>';
            return `<div class="proof-preview-item">
                <div class="proof-preview">${p.url ? `<img src="${p.url}" alt="">` : ''}${statusHtml}</div>
                <button type="button" class="proof-preview-remove" data-remove="${p.id}" aria-label="Remove photo"><i class="fas fa-xmark"></i></button>
            </div>`;
        }).join('');
        wrap.querySelectorAll('[data-remove]').forEach(btn => btn.addEventListener('click', () => this.removePhoto(btn.dataset.remove)));
    }

    // ---- Tesseract.js is only fetched the first time a photo is scanned ----
    loadScript(src) {
        return new Promise((resolve, reject) => {
            if (document.querySelector(`script[src="${src}"]`)) return resolve();
            const s = document.createElement('script');
            s.src = src;
            s.onload = () => resolve();
            s.onerror = () => reject(new Error('Could not load the photo scanner. Check your connection and try again.'));
            document.head.appendChild(s);
        });
    }

    async ensureWorker() {
        if (this.worker) return this.worker;
        if (!this.workerPromise) {
            this.workerPromise = (async () => {
                await this.loadScript('https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/6.0.0/tesseract.min.js');
                const worker = await Tesseract.createWorker('eng', 1, { logger: m => this.setStatus(m) });
                await worker.setParameters({
                    tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.,:/#- '
                });
                this.worker = worker;
                return worker;
            })();
        }
        return this.workerPromise;
    }

    setStatus(info) {
        const el = document.getElementById('proofScanStatus');
        if (!el) return;
        el.hidden = false;
        const labels = {
            'loading tesseract core': 'Preparing scanner…',
            'initializing tesseract': 'Preparing scanner…',
            'loading language traineddata': 'Downloading language data (first scan only)…',
            'initializing api': 'Almost ready…',
            'recognizing text': 'Reading your photo…'
        };
        if (info?.status === 'recognizing text') {
            const pct = Math.round((info.progress || 0) * 100);
            el.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Reading your photo… ${pct}%`;
        } else {
            el.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${app.escapeHtml(labels[info?.status] || 'Working…')}`;
        }
    }

    // Upscales small/blurry photos and boosts contrast — meaningfully improves
    // OCR accuracy on low-resolution photos of small feature-phone screens.
    preprocess(img) {
        const canvas = document.createElement('canvas');
        const scale = img.width < 1000 ? Math.min(3, 1400 / img.width) : 1;
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = frame.data;
        for (let i = 0; i < d.length; i += 4) {
            const gray = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
            const boosted = Math.max(0, Math.min(255, (gray - 128) * 1.35 + 128));
            d[i] = d[i + 1] = d[i + 2] = boosted;
        }
        ctx.putImageData(frame, 0, 0);
        return canvas;
    }

    // The object URL is created once, when the photo is attached (so the
    // preview thumbnail can use it) — this just decodes that same URL into
    // an Image for the OCR pipeline, rather than minting a second one.
    loadImage(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('That file could not be read as an image.'));
            img.src = url;
        });
    }

    extractAmount(text) {
        const near = text.match(/(?:ugx|ush|shs?|amount)[^\d]{0,6}([\d][\d,.\s]{2,})/i);
        if (near) {
            const n = parseInt(near[1].replace(/[^\d]/g, ''), 10);
            if (n) return n;
        }
        const grouped = text.match(/\b\d{1,3}(?:,\d{3})+\b/);
        if (grouped) return parseInt(grouped[0].replace(/,/g, ''), 10);
        return null;
    }

    extractReference(text) {
        const labelled = text.match(/(?:trans(?:action)?\s*id|txn\s*id|\btid\b|financial\s*transaction\s*id|reference\s*(?:no|number)?|ref\s*no)[^A-Za-z0-9]{0,4}([A-Za-z0-9]{5,20})/i);
        if (labelled) return labelled[1].toUpperCase();
        const idIdx = text.search(/\bid\b/i);
        if (idIdx > -1) {
            const window_ = text.slice(idIdx, idIdx + 40);
            const tokens = window_.match(/[A-Za-z0-9]{6,20}/g);
            if (tokens?.length) {
                const mixed = tokens.find(t => /[A-Za-z]/.test(t) && /\d/.test(t));
                return (mixed || tokens[0]).toUpperCase();
            }
        }
        return null;
    }

    renderResult() {
        const resEl = document.getElementById('proofResult');
        if (!resEl) return;
        if (!this.extracted.reference && !this.extracted.amount) { resEl.hidden = true; return; }
        resEl.hidden = false;

        const expected = this.manager?.expectedAmount ? this.manager.expectedAmount() : null;
        const amountRow = document.getElementById('proofAmountRow');
        if (amountRow) {
            if (this.extracted.amount) {
                const matches = expected != null && this.extracted.amount === expected;
                amountRow.innerHTML = `<strong>${app.formatCurrency(this.extracted.amount)}</strong>` + (
                    expected == null ? '' : matches
                        ? '<span class="proof-amount-check is-match"><i class="fas fa-circle-check"></i> Matches your plan</span>'
                        : `<span class="proof-amount-check is-mismatch"><i class="fas fa-triangle-exclamation"></i> Plan total is ${app.formatCurrency(expected)}</span>`
                );
            } else {
                amountRow.innerHTML = '<span class="proof-amount-unknown">Not detected — check it against your plan total above</span>';
            }
        }

        const refInput = document.getElementById('proofRefInput');
        if (refInput && this.extracted.reference && !refInput.value) refInput.value = this.extracted.reference;
        const useBtn = document.getElementById('proofUseBtn');
        if (useBtn) useBtn.disabled = !refInput?.value?.trim();
    }

    useDetails() {
        const ref = document.getElementById('proofRefInput')?.value.trim();
        if (!ref) return;
        const mainRef = document.getElementById('subReference');
        if (mainRef) {
            mainRef.value = ref;
            mainRef.dispatchEvent(new Event('input'));
        }
        const chip = document.getElementById('scanProofChip');
        if (chip) {
            chip.hidden = false;
            chip.innerHTML = '<i class="fas fa-camera"></i> Photo attached · tap to rescan';
        }
        this.close();
        app.showAlert('Transaction ID filled in from your photo — please double-check it matches your SMS.', 'success');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.subscriptionManager = new SubscriptionManager();
    window.proofScanner = new ProofScanner(window.subscriptionManager);
});
