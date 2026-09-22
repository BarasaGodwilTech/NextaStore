class SubscriptionManager {
    constructor() {
        this.data = null;
        this.allowedMonths = [1, 3, 6, 12, 24];
        this.init();
    }

    async init() {
        document.getElementById('subMonths')?.addEventListener('change', () => this.syncAmount());
        this.syncAmount();
        await this.load();
        document.getElementById('subPaymentForm')?.addEventListener('submit', e => this.submitPayment(e));
    }

    async load() {
        try {
            const res = await app.apiRequest('/subscription');
            this.data = res.data || {};
            this.renderStatus();
            this.renderGoal();
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
        if (this.data?.isPaid && remaining > 0 && this.allowedMonths.includes(remaining)) return remaining;
        if (!this.data?.isPaid && this.allowedMonths.includes(6)) return 6;
        return 1;
    }

    syncAmount(afterLoad = false) {
        const monthsEl = document.getElementById('subMonths');
        const amountEl = document.getElementById('subAmount');
        const hint = document.getElementById('subAmountHint');
        const monthsHint = document.getElementById('subMonthsHint');
        if (!monthsEl || !amountEl) return;

        if (afterLoad && this.data) {
            const recommended = this.recommendedMonths();
            if ([...monthsEl.options].some(o => Number(o.value) === recommended)) monthsEl.value = String(recommended);
        }
        const months = Number(monthsEl.value || 1);
        const amount = this.expectedAmount();
        amountEl.value = amount;
        amountEl.min = String(amount);
        amountEl.max = String(amount);
        if (hint) hint.textContent = `Send exactly ${app.formatCurrency(amount)} for ${months} month${months === 1 ? '' : 's'}. The server checks the amount before saving your submission.`;
        if (monthsHint && this.data?.isPaid) monthsHint.textContent = 'Your next approved payment is added to your current paid coverage while it is still active.';
    }

    renderStatus() {
        const card = document.getElementById('subStatusCard');
        const d = this.data || {};
        const price = Number(d.priceUgx || 20000);
        const priceLabel = document.getElementById('subPriceLabel');
        if (priceLabel) priceLabel.textContent = app.formatCurrency(price);

        if (d.status === 'trial') {
            card.innerHTML = `<div class="status-card-main"><span class="subscription-status-pill status-trial"><i class="fas fa-gift"></i> Free trial</span><h2>Your store is active for now</h2><p>You have <strong>${d.daysLeft} day${d.daysLeft === 1 ? '' : 's'}</strong> left on the free Seller Pass. Pay early to keep your store active after the trial ends.</p></div><div class="status-card-side"><strong>${d.daysLeft}</strong><span>days left</span></div>`;
        } else if (d.status === 'active') {
            const badge = d.badge ? `<span class="inline-badge inline-badge--${app.escapeHtml(d.badge.tone)}"><i class="fas ${app.escapeHtml(d.badge.icon)}"></i>${app.escapeHtml(d.badge.label)}</span>` : '<span class="threshold-pill"><i class="fas fa-lock"></i> Badge starts at 6 months</span>';
            card.innerHTML = `<div class="status-card-main"><span class="subscription-status-pill status-active"><i class="fas fa-circle-check"></i> Paid Seller Pass</span><h2>${badge}</h2><p>Your paid coverage runs until <strong>${app.formatDate(d.subscriptionPaidUntil)}</strong>. You have <strong>${d.daysLeft} day${d.daysLeft === 1 ? '' : 's'}</strong> left and <strong>${d.commitmentMonths || 0} month${Number(d.commitmentMonths) === 1 ? '' : 's'}</strong> in your current paid coverage.</p></div><div class="status-card-side"><strong>${d.commitmentMonths || 0}</strong><span>months covered</span></div>`;
        } else {
            card.innerHTML = `<div class="status-card-main"><span class="subscription-status-pill status-expired"><i class="fas fa-hourglass-end"></i> Seller Pass ended</span><h2>Renew your store before your next customer visit.</h2><p>Your paid access has ended. Choose a new coverage period below. <strong>6 months or more earns a seller badge after approval.</strong></p></div><div class="status-card-side"><i class="fas fa-arrow-rotate-right"></i><span>Ready to renew</span></div>`;
        }
    }

    renderGoal() {
        const el = document.getElementById('subGoalCard');
        const d = this.data || {};
        if (!el) return;
        const months = Number(d.commitmentMonths || 0);
        if (d.badge) {
            const next = d.nextBadgeMonths;
            if (next) {
                el.innerHTML = `<div class="goal-icon"><i class="fas ${app.escapeHtml(d.badge.icon)}"></i></div><div><strong>${app.escapeHtml(d.badge.label)} is live</strong><p>You have ${months} months of active paid coverage. Add <strong>${d.monthsToNextBadge} more month${d.monthsToNextBadge === 1 ? '' : 's'}</strong> to reach ${next === 12 ? 'Gold Partner' : 'Platinum Partner'}.</p></div>`;
            } else {
                el.innerHTML = `<div class="goal-icon"><i class="fas fa-gem"></i></div><div><strong>Top badge reached</strong><p>Your current paid coverage qualifies for Platinum Partner. Additional payments can extend the end date without changing the badge level.</p></div>`;
            }
        } else if (d.isPaid && months > 0) {
            el.innerHTML = `<div class="goal-icon goal-icon-muted"><i class="fas fa-bullseye"></i></div><div><strong>${months} month${months === 1 ? '' : 's'} covered so far</strong><p>Add <strong>${d.monthsToNextBadge} more month${d.monthsToNextBadge === 1 ? '' : 's'}</strong> while your current pass is active to reach Verified Seller.</p></div><button type="button" class="btn btn-outline btn-sm" id="goalAddButton">Add ${d.monthsToNextBadge} month${d.monthsToNextBadge === 1 ? '' : 's'}</button>`;
            document.getElementById('goalAddButton')?.addEventListener('click', () => {
                const select = document.getElementById('subMonths');
                if (select) { select.value = String(d.monthsToNextBadge); this.syncAmount(); select.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
            });
        } else {
            el.innerHTML = `<div class="goal-icon goal-icon-muted"><i class="fas fa-flag-checkered"></i></div><div><strong>First badge starts at 6 months</strong><p>A 6-month approved payment unlocks Verified Seller. Smaller payments keep the store paid but do not create a badge yet.</p></div><button type="button" class="btn btn-primary btn-sm" id="goalStartButton">Choose 6 months</button>`;
            document.getElementById('goalStartButton')?.addEventListener('click', () => {
                const select = document.getElementById('subMonths');
                if (select) { select.value = '6'; this.syncAmount(); select.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
            });
        }
    }

    renderPayNumbers(info) {
        const el = document.getElementById('subPayNumbers');
        const rows = [];
        const add = (method, icon, label, code, name) => {
            if (!code) return;
            rows.push(`<button type="button" class="subscription-pay-number" data-pay-method="${method}"><span class="pay-number-main"><i class="fas ${icon}"></i><span><strong>${app.escapeHtml(label)}</strong><small>${app.escapeHtml(name || 'NextaStore')} · mobile money</small></span></span><code>${app.escapeHtml(code)}</code></button>`);
        };
        add('mtnMomo', 'fa-mobile-screen-button', 'MTN MoMo', info.mtnMomoCode, info.mtnMomoName);
        add('airtelMoney', 'fa-mobile-screen-button', 'Airtel Money', info.airtelMoneyCode, info.airtelMoneyName);
        el.innerHTML = rows.length ? rows.join('') : '<div class="subscription-pay-empty"><i class="fas fa-circle-info"></i><span>Mobile-money payment details have not been configured yet. Contact NextaStore before sending money.</span></div>';
        el.querySelectorAll('[data-pay-method]').forEach(btn => btn.addEventListener('click', () => {
            const method = btn.dataset.payMethod;
            const select = document.getElementById('subMethod');
            if (select) select.value = method;
            el.querySelectorAll('[data-pay-method]').forEach(x => x.classList.toggle('is-selected', x === btn));
        }));
        const current = document.getElementById('subMethod')?.value;
        el.querySelectorAll('[data-pay-method]').forEach(x => x.classList.toggle('is-selected', x.dataset.payMethod === current));
    }

    renderHistory() {
        const el = document.getElementById('subHistory');
        const payments = Array.isArray(this.data?.payments) ? this.data.payments : [];
        if (!payments.length) {
            el.innerHTML = '<div class="subscription-history-empty"><i class="fas fa-receipt"></i><strong>No payment submitted yet</strong><span>Your first mobile-money payment will appear here after you submit the transaction ID.</span></div>';
            return;
        }
        el.innerHTML = payments.map(p => {
            const method = p.method === 'mtnMomo' ? 'MTN MoMo' : 'Airtel Money';
            const status = String(p.status || 'pending').toLowerCase();
            const title = status === 'approved' ? 'Payment approved' : status === 'rejected' ? 'Payment not confirmed' : 'Waiting for checking';
            return `<article class="subscription-payment-row"><div class="subscription-payment-main"><strong>${title} · ${app.formatCurrency(p.amount)}</strong><small>${method} · ${app.escapeHtml(p.reference)} · ${p.periodMonths} month${p.periodMonths === 1 ? '' : 's'} · ${app.escapeHtml(app.formatDate(p.submittedAt))}</small>${p.note ? `<em>${app.escapeHtml(p.note)}</em>` : ''}</div><span class="subscription-payment-status ${app.escapeHtml(status)}">${status === 'approved' ? 'Approved' : status === 'rejected' ? 'Not confirmed' : 'Pending'}</span></article>`;
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

        if (!amount || !reference) return app.showAlert('Please enter the amount you sent and the transaction ID from your mobile-money SMS.', 'warning');
        if (amount !== expected) { app.showAlert(`The correct amount is ${app.formatCurrency(expected)} for ${periodMonths} month${periodMonths === 1 ? '' : 's'}.`, 'warning'); this.syncAmount(); return; }
        if (!this.data?.paymentInfo?.[method + 'Code']) return app.showAlert('That mobile-money payment option is not currently configured. Please contact NextaStore.', 'warning');

        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending for checking…';
        try {
            await app.apiRequest('/subscription/payments', { method: 'POST', body: JSON.stringify({ amount, method, reference, periodMonths }) });
            app.showAlert('Payment submitted. We will check the transaction before adding the months or badge.', 'success');
            document.getElementById('subPaymentForm').reset();
            this.syncAmount();
            await this.load();
        } catch (err) { app.showAlert(err.message, 'error'); }
        finally { btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> Send payment for checking'; }
    }
}

document.addEventListener('DOMContentLoaded', () => { window.subscriptionManager = new SubscriptionManager(); });
