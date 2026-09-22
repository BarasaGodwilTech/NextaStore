class AdminConsole {
    constructor() {
        this.access = null;
        this.roles = [];
        this.permissions = [];
        this.userPage = 1;
        this.init();
    }

    async init() {
        this.bindTabs();
        document.getElementById('adminRefresh')?.addEventListener('click', () => this.refreshAll());
        document.querySelectorAll('[data-jump]').forEach(b => b.addEventListener('click', () => this.showTab(b.dataset.jump)));
        document.getElementById('userSearchBtn')?.addEventListener('click', () => this.loadUsers(1));
        document.getElementById('userSearch')?.addEventListener('keydown', e => { if (e.key === 'Enter') this.loadUsers(1); });
        document.getElementById('refreshSubPayments')?.addEventListener('click', () => this.loadPayments());
        document.getElementById('refreshReports')?.addEventListener('click', () => this.loadReports());
        document.getElementById('createFollowUp')?.addEventListener('click', () => this.openFollowUpModal());
        document.getElementById('newFollowUpFromUsers')?.addEventListener('click', () => this.openFollowUpModal());
        document.getElementById('createRole')?.addEventListener('click', () => this.openRoleModal());
        document.getElementById('refreshAudit')?.addEventListener('click', () => this.loadAudit());
        document.getElementById('settingsForm')?.addEventListener('submit', e => this.saveSettings(e));
        document.getElementById('addPaymentMethod')?.addEventListener('click', () => this.openPaymentMethodModal());
        document.addEventListener('keydown', e => { if (e.key === 'Escape') { const root = document.getElementById('adminModalRoot'); if (root?.firstElementChild) root.innerHTML = ''; } });

        try {
            const me = await app.apiRequest('/user/me');
            this.access = me.data;
            document.getElementById('adminLevelLabel').textContent = this.access?.adminLevel === 'super_admin' ? 'Super administrator · full access' : (this.access?.adminRole?.name || 'Administrator');
            this.applyAccessVisibility();
            await this.loadTabData('overview');
        } catch (err) {
            app.showAlert(err.message, 'error');
        }
    }

    isSuper() { return this.access?.adminLevel === 'super_admin'; }
    // NB: not called permissions(): the constructor's this.permissions (the
    // list of every permission, for the role editor) would shadow it, and
    // can() then threw for every admin who is not a super admin.
    ownPermissions() { return this.access?.adminRole?.permissions || []; }
    can(permission) { return this.isSuper() || this.ownPermissions().includes(permission); }
    canGrant(perms) { return this.isSuper() || (perms || []).every(p => this.can(p)); }
    canOpenTeam() { return this.isSuper() || this.can('roles.manage') || this.can('admins.manage'); }

    applyAccessVisibility() {
        // Every module maps to a permission. An admin without it does not get
        // the sidebar link, the Overview shortcut, the section or the stat
        // card: they are REMOVED from the page, not hidden or greyed out, so
        // nothing about a module they cannot use is even in their DOM. (The
        // API refuses those calls too; this is just the honest UI for it.)
        const allowedModules = {
            users: this.can('users.view'),
            payments: this.can('subscriptions.review'),
            reports: this.can('reports.review'),
            followups: this.can('followups.manage'),
            team: this.canOpenTeam(),
            settings: this.can('settings.manage'),
            audit: this.can('audit.view')
        };
        Object.entries(allowedModules).forEach(([name, allowed]) => {
            if (allowed) return;
            document.querySelectorAll(`[data-admin-tab="${name}"], [data-admin-section="${name}"], [data-jump="${name}"]`).forEach(el => el.remove());
        });

        // Overview numbers: the dashboard permission gates the whole strip,
        // then each card follows the module it counts.
        if (!this.can('dashboard.view')) document.getElementById('adminStats')?.remove();
        this.removeStatCard('statAdmins', this.isSuper() || this.can('admins.manage'));
        this.removeStatCard('statPayments', allowedModules.payments);
        this.removeStatCard('statReports', allowedModules.reports);
        this.removeStatCard('statFollowUps', allowedModules.followups);
        if (!allowedModules.followups) document.getElementById('newFollowUpFromUsers')?.remove();
        if (!this.can('roles.manage')) document.getElementById('createRole')?.remove();

        // Tidy what the removals left behind: empty nav groups, an empty
        // shortcut panel.
        document.querySelectorAll('[data-nav-group]').forEach(g => { if (!g.querySelector('[data-admin-tab]')) g.remove(); });
        const quick = document.querySelector('.admin-quick-panel');
        if (quick && !quick.querySelector('[data-jump]')) quick.remove();
        const grid = document.querySelector('.admin-overview-grid');
        if (grid && grid.children.length === 1) grid.classList.add('is-single');

        // A stale #hash or a role change since load could leave the active
        // tab removed; Overview always exists.
        if (!document.querySelector('[data-admin-tab].is-active')) this.showTab('overview');
    }

    removeStatCard(id, allowed) {
        if (allowed) return;
        document.getElementById(id)?.closest('.admin-stat')?.remove();
    }

    bindTabs() {
        document.querySelectorAll('[data-admin-tab]').forEach(btn => btn.addEventListener('click', () => this.showTab(btn.dataset.adminTab)));
    }

    showTab(name) {
        document.querySelectorAll('[data-admin-tab]').forEach(b => b.classList.toggle('is-active', b.dataset.adminTab === name));
        document.querySelectorAll('[data-admin-section]').forEach(s => s.classList.toggle('is-active', s.dataset.adminSection === name));
        this.loadTabData(name);
    }

    async loadTabData(name) {
        const jobs = {
            overview: () => this.loadOverview(),
            users: () => this.loadUsers(this.userPage),
            payments: () => this.loadPayments(),
            reports: () => this.loadReports(),
            followups: () => this.loadFollowUps(),
            team: () => this.loadRoles(),
            settings: async () => { await this.loadSettings(); await this.loadPaymentMethods(); },
            audit: () => this.loadAudit()
        };
        if (jobs[name]) await jobs[name]();
    }

    async refreshAll() {
        await this.loadOverview();
        const active = document.querySelector('[data-admin-tab].is-active')?.dataset.adminTab || 'overview';
        await this.loadTabData(active);
    }

    async loadOverview() {
        try {
            if (!this.can('dashboard.view')) return;
            const r = await app.apiRequest('/admin/overview');
            const d = r.data || {};
            for (const [id, key] of [['statUsers','users'],['statSellers','sellers'],['statPayments','pendingPayments'],['statReports','openReports'],['statAdmins','admins'],['statFollowUps','openFollowUps']]) this.setText(id, d[key] ?? 0);
        } catch (e) { this.setText('statUsers','—'); }
    }

    setText(id, value) { const el = document.getElementById(id); if (el) el.textContent = value; }

    async loadUsers(page = 1) {
        if (!this.can('users.view')) return this.renderLocked('usersList', 'You do not have permission to view user accounts.');
        const list = document.getElementById('usersList');
        list.innerHTML = '<div class="admin-loading"><i class="fas fa-spinner fa-spin"></i> Loading accounts…</div>';
        this.userPage = page;
        const search = document.getElementById('userSearch')?.value.trim() || '';
        const role = document.getElementById('userRoleFilter')?.value || '';
        const accountStatus = document.getElementById('userStatusFilter')?.value || '';
        try {
            const q = new URLSearchParams({ page, pageSize: 20 });
            if (search) q.set('search', search); if (role) q.set('role', role); if (accountStatus) q.set('accountStatus', accountStatus);
            const r = await app.apiRequest(`/admin/users?${q}`);
            this.renderUsers(r.data || { users: [] });
        } catch (e) { list.innerHTML = `<div class="admin-empty"><i class="fas fa-lock"></i><strong>Accounts unavailable</strong><p>${app.escapeHtml(e.message)}</p></div>`; }
    }

    renderUsers(data) {
        const list = document.getElementById('usersList');
        const rows = data.users || [];
        if (!rows.length) { list.innerHTML = '<div class="admin-empty"><i class="fas fa-user-slash"></i><strong>No matching accounts</strong><p>Try a different name, email or filter.</p></div>'; this.renderPagination(data); return; }
        list.innerHTML = `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Account</th><th>Role</th><th>Status</th><th>Seller status</th><th>Created</th><th>Actions</th></tr></thead><tbody>${rows.map(u => {
            const initial = app.escapeHtml(app.getInitial(u.name));
            const seller = u.store ? (u.store.verified ? `<span class="seller-badge seller-badge--verified"><i class="fas fa-circle-check"></i> Badge live</span>` : `<span class="admin-chip">${u.store.subscription?.status || 'trial'}</span>`) : '—';
            const adminRole = u.adminRole ? ` · ${app.escapeHtml(u.adminRole.name)}` : '';
            const canManageRow = !(u.adminLevel === 'super_admin' && !this.isSuper()) && !(u.role === 'admin' && !this.can('admins.manage'));
            const canEditRow = canManageRow && (this.can('users.edit') || this.can('users.suspend'));
            const canResetRow = canManageRow && this.can('users.password_reset');
            const actions = (canEditRow ? `<button class="btn btn-outline btn-sm" data-edit-user="${app.escapeHtml(u.id)}">Edit</button>` : '') + (canResetRow ? `<button class="btn btn-outline btn-sm" data-reset-user="${app.escapeHtml(u.id)}">Reset password</button>` : '');
            return `<tr><td data-label="Account"><div class="user-cell"><span class="user-mini-avatar">${initial}</span><div><strong>${app.escapeHtml(u.name)}</strong><small>${app.escapeHtml(u.email)}</small></div></div></td><td data-label="Role"><span class="admin-chip role-${app.escapeHtml(u.role)}">${app.escapeHtml(u.role)}${adminRole}</span></td><td data-label="Status"><span class="admin-chip ${u.accountStatus === 'suspended' ? 'suspended' : 'active'}">${u.accountStatus === 'suspended' ? 'Suspended' : 'Active'}</span></td><td data-label="Seller">${seller}</td><td data-label="Created">${app.escapeHtml(app.formatDate(u.createdAt))}</td><td class="admin-actions-cell">${actions ? `<div class="admin-actions">${actions}</div>` : '<span class="admin-muted">View only</span>'}</td></tr>`;
        }).join('')}</tbody></table></div>`;
        list.querySelectorAll('[data-edit-user]').forEach(b => b.addEventListener('click', () => this.openUserModal(b.dataset.editUser)));
        list.querySelectorAll('[data-reset-user]').forEach(b => b.addEventListener('click', () => this.resetPassword(b.dataset.resetUser)));
        this.renderPagination(data);
    }

    renderPagination(data) {
        const el = document.getElementById('usersPagination'); if (!el) return;
        const page = Number(data.page || 1), pages = Number(data.pages || 1);
        el.innerHTML = `<button class="btn btn-outline btn-sm" ${page <= 1 ? 'disabled' : ''} data-page-prev>Previous</button><span style="align-self:center;font-size:.65rem;color:#75847f">Page ${page} of ${Math.max(1,pages)}</span><button class="btn btn-outline btn-sm" ${page >= pages ? 'disabled' : ''} data-page-next>Next</button>`;
        el.querySelector('[data-page-prev]')?.addEventListener('click', () => this.loadUsers(page - 1));
        el.querySelector('[data-page-next]')?.addEventListener('click', () => this.loadUsers(page + 1));
    }

    async openUserModal(id) {
        try {
            // The role list is only needed (and only readable) for someone who
            // can manage administrators.
            const canAdmins = this.can('admins.manage');
            const [userRes, rolesRes] = await Promise.all([
                app.apiRequest(`/admin/users/${encodeURIComponent(id)}`),
                canAdmins ? app.apiRequest('/admin/roles') : Promise.resolve(null)
            ]);
            const u = userRes.data.user; this.roles = rolesRes?.data?.roles || [];
            const esc = app.escapeHtml;
            const canEdit = this.can('users.edit');
            const canSuspend = this.can('users.suspend');
            // Only roles made of permissions the editor holds themselves can be
            // handed out (the API enforces the same); the one already assigned
            // stays listed so the form still shows the truth.
            const assignable = this.roles.filter(r => this.canGrant(r.permissions) || r.id === u.adminRole?.id);
            const showAdminFields = canAdmins && (u.role === 'admin');
            const roleOptions = ['buyer', 'seller'].concat(canAdmins || u.role === 'admin' ? ['admin'] : []);
            const label = { buyer: 'Buyer', seller: 'Seller', admin: 'Administrator' };
            const detail = (k, v) => `<div><span>${k}</span><strong>${v}</strong></div>`;
            const root = document.getElementById('adminModalRoot');
            root.innerHTML = `<div class="admin-modal-backdrop" data-modal-close><div class="admin-modal" role="dialog" aria-modal="true" aria-labelledby="userModalTitle"><div class="admin-modal-head"><div><span class="panel-kicker">Account</span><h2 id="userModalTitle">${canEdit ? 'Edit' : 'Manage'} ${esc(u.name)}</h2></div><button class="btn btn-ghost btn-sm" data-close-modal aria-label="Close"><i class="fas fa-xmark"></i></button></div><form id="userEditForm"><div class="admin-modal-body"><div class="admin-modal-grid">${
                canEdit
                    ? `<label>Name<input name="name" value="${esc(u.name)}" required></label><label>Email<input name="email" type="email" value="${esc(u.email)}" required></label><label>Account role<select name="role">${roleOptions.map(r => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${label[r]}</option>`).join('')}</select></label>`
                    : `<div class="full"><div class="detail-list">${detail('Name', esc(u.name))}${detail('Email', esc(u.email))}${detail('Account role', esc(label[u.role] || u.role))}</div></div>`
            }${canSuspend ? `<label>Status<select name="accountStatus"><option value="active" ${u.accountStatus === 'active' ? 'selected' : ''}>Active</option><option value="suspended" ${u.accountStatus === 'suspended' ? 'selected' : ''}>Suspended</option></select></label>` : ''
            }${showAdminFields && this.isSuper() ? `<label>Admin level<select name="adminLevel"><option value="standard" ${u.adminLevel !== 'super_admin' ? 'selected' : ''}>Standard administrator</option><option value="super_admin" ${u.adminLevel === 'super_admin' ? 'selected' : ''}>Super administrator</option></select></label>` : ''
            }${showAdminFields ? `<label>Admin role<select name="adminRoleId"><option value="">No role (no access)</option>${assignable.map(r => `<option value="${esc(r.id)}" ${u.adminRole?.id === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>` : ''
            }<div class="full"><div class="detail-list">${detail('Store', u.store ? esc(u.store.name) : 'No store')}${detail('Email verified', u.emailVerified ? 'Yes' : 'No')}${detail('Current badge', esc(u.store?.subscription?.badge?.label || 'No badge'))}</div></div></div></div><div class="admin-modal-footer"><button type="button" class="btn btn-outline" data-close-modal>Cancel</button><button type="submit" class="btn btn-primary">Save account</button></div></form></div></div>`;
            const modal = root.firstElementChild;
            modal.addEventListener('click', e => { if (e.target === modal || e.target.closest('[data-close-modal]')) root.innerHTML=''; });
            const form = document.getElementById('userEditForm');
            form.addEventListener('submit', async e => {
                e.preventDefault();
                const fd = new FormData(form);
                // Send only the fields this admin was actually shown (and so
                // may change).
                const payload = {};
                for (const key of ['name', 'email', 'role', 'accountStatus', 'adminLevel']) if (fd.has(key)) payload[key] = fd.get(key);
                if (fd.has('adminRoleId')) payload.adminRoleId = fd.get('adminRoleId') || null;
                const save = form.querySelector('button[type=submit]'); save.disabled = true;
                try { await app.apiRequest(`/admin/users/${encodeURIComponent(id)}`, { method:'PUT', body:JSON.stringify(payload) }); root.innerHTML=''; app.showAlert('Account updated.', 'success'); await this.loadUsers(this.userPage); await this.loadOverview(); }
                catch(err){ save.disabled=false; app.showAlert(err.message,'error'); }
            });
        } catch (e) { app.showAlert(e.message, 'error'); }
    }

    async resetPassword(id) {
        if (!this.can('users.password_reset')) return app.showAlert('You do not have permission to start password resets.', 'error');
        const confirmed = await app.confirm({ title:'Start password reset?', message:'NextaStore will create a one-time password reset link and, where email is configured, send it to the user.', confirmText:'Start reset', tone:'warning' });
        if (!confirmed) return;
        try {
            const r = await app.apiRequest(`/admin/users/${encodeURIComponent(id)}/password-reset`, { method:'POST' });
            if (r.data?.resetUrl && !r.data?.emailed) window.prompt('The email could not be sent. Copy this secure reset link and send it to the user:', r.data.resetUrl);
            app.showAlert(r.data?.emailed ? 'Password reset instructions sent.' : 'Reset link created for follow-up.', 'success');
        } catch (e) { app.showAlert(e.message,'error'); }
    }

    async loadPayments() {
        if (!this.can('subscriptions.review')) return this.renderLocked('subPaymentsList','You do not have permission to review seller payments.');
        const list = document.getElementById('subPaymentsList'); list.innerHTML='<div class="admin-loading"><i class="fas fa-spinner fa-spin"></i> Loading payments…</div>';
        try { const r=await app.apiRequest('/admin/subscription-payments'); this.renderPayments(r.data||[]); } catch(e){ list.innerHTML=`<div class="admin-empty"><i class="fas fa-lock"></i><strong>Payments unavailable</strong><p>${app.escapeHtml(e.message)}</p></div>`; }
    }
    renderPayments(rows){ const list=document.getElementById('subPaymentsList'); if(!rows.length){list.innerHTML='<div class="admin-empty"><i class="fas fa-receipt"></i><strong>No seller payments yet</strong><p>Submitted mobile-money payments will appear here.</p></div>';return;} list.innerHTML=rows.map(p=>{const s=p.store||{};const action=p.status==='pending'?`<div class="admin-status"><button class="btn btn-primary btn-sm" data-approve-payment="${app.escapeHtml(p.id)}">Approve</button><button class="btn btn-outline btn-sm" data-reject-payment="${app.escapeHtml(p.id)}">Reject</button></div>`:`<div class="admin-status"><span class="admin-chip ${p.status==='approved'?'active':'suspended'}">${app.escapeHtml(p.status)}</span></div>`;const covered=Number(s.badgeCommitmentMonths||0);return `<article class="admin-report"><div><h3>${app.escapeHtml(s.name||'Store')} <small>· ${p.periodMonths} month${p.periodMonths===1?'':'s'}</small></h3><div class="admin-meta"><span>${app.formatCurrency(p.amount)}</span><span>${p.method==='mtnMomo'?'MTN MoMo':'Airtel Money'}</span><span>${app.escapeHtml(p.reference)}</span><span>${app.escapeHtml(app.formatDate(p.submittedAt))}</span><span>Current coverage: ${covered} mo</span></div><p><strong>Owner:</strong> ${app.escapeHtml(s.owner?.name||'—')} · ${app.escapeHtml(s.owner?.email||'—')}</p><p>${p.status==='pending'?'Confirm the payment in the merchant account before approving. If the seller already has active paid coverage, this payment will be added to it.':''}</p></div>${action}</article>`;}).join(''); list.querySelectorAll('[data-approve-payment]').forEach(b=>b.addEventListener('click',()=>this.approvePayment(b.dataset.approvePayment,b)));list.querySelectorAll('[data-reject-payment]').forEach(b=>b.addEventListener('click',()=>this.rejectPayment(b.dataset.rejectPayment,b))); }
    async approvePayment(id,btn){const ok=await app.confirm({title:'Approve this payment?',message:'Only approve after you have confirmed the mobile-money transaction. Any active paid coverage will be extended by the submitted months.',confirmText:'Approve payment',tone:'success'});if(!ok)return;btn.disabled=true;try{const r=await app.apiRequest(`/admin/subscription-payments/${encodeURIComponent(id)}/approve`,{method:'PUT'});app.showAlert(r.data?.badgeEligible?'Payment approved and seller badge updated.':'Payment approved and paid coverage extended.','success');await this.loadPayments();await this.loadOverview();}catch(e){btn.disabled=false;app.showAlert(e.message,'error')}}
    async rejectPayment(id,btn){const note=window.prompt('Why could you not confirm this payment? This note will be sent to the seller:')||'';btn.disabled=true;try{await app.apiRequest(`/admin/subscription-payments/${encodeURIComponent(id)}/reject`,{method:'PUT',body:JSON.stringify({note})});app.showAlert('Payment marked as not confirmed.','success');await this.loadPayments();await this.loadOverview();}catch(e){btn.disabled=false;app.showAlert(e.message,'error')}}

    async loadReports(){if(!this.can('reports.review'))return this.renderLocked('reportsList','You do not have permission to review reports.');const list=document.getElementById('reportsList');list.innerHTML='<div class="admin-loading"><i class="fas fa-spinner fa-spin"></i> Loading reports…</div>';try{const r=await app.apiRequest('/admin/reports');this.renderReports(r.data||[])}catch(e){list.innerHTML=`<div class="admin-empty"><i class="fas fa-lock"></i><strong>Reports unavailable</strong><p>${app.escapeHtml(e.message)}</p></div>`}}
    renderReports(rows){const list=document.getElementById('reportsList');if(!rows.length){list.innerHTML='<div class="admin-empty"><i class="fas fa-shield-heart"></i><strong>No reports waiting</strong><p>There are no order issues in the queue.</p></div>';return;}list.innerHTML=rows.map(x=>{const o=x.order||{},s=o.store||{};return `<article class="admin-report"><div><h3>Order #${app.escapeHtml(o.id||'')}</h3><div class="admin-meta"><span>${app.escapeHtml(s.name||'Store')}</span><span>${app.escapeHtml(o.status||'')}</span><span>${app.escapeHtml(x.reporter?.name||'Reporter')}</span><span>${app.escapeHtml(app.formatDate(x.createdAt))}</span></div><p><strong>Reason:</strong> ${app.escapeHtml(x.reason)}</p><p><strong>Customer:</strong> ${app.escapeHtml(o.customerName||'—')} · ${app.escapeHtml(o.customerPhone||'—')} · ${app.formatCurrency(o.total||0)}</p></div><div class="admin-status">${x.reviewedAt?'<span class="admin-chip active">Reviewed</span>':'<button class="btn btn-outline btn-sm" data-review-report="'+app.escapeHtml(x.id)+'">Mark handled</button>'}</div></article>`}).join('');list.querySelectorAll('[data-review-report]').forEach(b=>b.addEventListener('click',async()=>{b.disabled=true;try{await app.apiRequest(`/admin/reports/${encodeURIComponent(b.dataset.reviewReport)}/review`,{method:'PUT'});await this.loadReports();await this.loadOverview()}catch(e){b.disabled=false;app.showAlert(e.message,'error')}}))}

    async loadFollowUps(){if(!this.can('followups.manage'))return this.renderLocked('followUpsList','You do not have permission to manage follow-ups.');const list=document.getElementById('followUpsList');list.innerHTML='<div class="admin-loading"><i class="fas fa-spinner fa-spin"></i> Loading follow-ups…</div>';try{const r=await app.apiRequest('/admin/follow-ups');this.renderFollowUps(r.data||[])}catch(e){list.innerHTML=`<div class="admin-empty"><i class="fas fa-lock"></i><strong>Follow-ups unavailable</strong><p>${app.escapeHtml(e.message)}</p></div>`}}
    renderFollowUps(rows){const list=document.getElementById('followUpsList');if(!rows.length){list.innerHTML='<div class="admin-empty"><i class="fas fa-list-check"></i><strong>No follow-ups</strong><p>Create one when a seller, buyer or admin case needs another action.</p></div>';return;}list.innerHTML=rows.map(x=>`<article class="admin-followup-row"><div><div class="followup-title">${app.escapeHtml(x.title)}</div><div class="followup-note">${app.escapeHtml(x.note||'No note')}</div><div class="followup-meta"><span>${app.escapeHtml(x.status)}</span><span>${x.relatedUser?app.escapeHtml(x.relatedUser.name):'No user linked'}</span><span>${x.assignedTo?`Assigned to ${app.escapeHtml(x.assignedTo.name)}`:'Unassigned'}</span><span>${x.dueAt?`Due ${app.escapeHtml(app.formatDate(x.dueAt))}`:'No due date'}</span></div></div><div class="followup-status"><button class="btn btn-outline btn-sm" data-edit-followup="${app.escapeHtml(x.id)}">Update</button></div></article>`).join('');list.querySelectorAll('[data-edit-followup]').forEach(b=>b.addEventListener('click',()=>this.openFollowUpModal(b.dataset.editFollowup)))}

    async openFollowUpModal(id=null){let current=null, admins=[];try{admins=(await app.apiRequest('/admin/administrators')).data||[];if(id)current=(await app.apiRequest(`/admin/follow-ups?`)).data.find(x=>x.id===id)||null;}catch(e){return app.showAlert(e.message,'error')}
        if(id&&!current){try{const rows=(await app.apiRequest('/admin/follow-ups')).data||[];current=rows.find(x=>x.id===id)}catch(e){}}
        const root=document.getElementById('adminModalRoot');root.innerHTML=`<div class="admin-modal-backdrop" data-modal-close><div class="admin-modal"><div class="admin-modal-head"><div><span class="panel-kicker">Operations</span><h2>${current?'Update follow-up':'Add follow-up'}</h2></div><button class="btn btn-ghost btn-sm" data-close-modal><i class="fas fa-xmark"></i></button></div><form id="followupForm"><div class="admin-modal-body"><div class="admin-modal-grid"><label>Title<div><input name="title" value="${app.escapeHtml(current?.title||'')}" placeholder="Call seller about payment" required></div></label><label>Status<select name="status"><option value="open" ${current?.status==='open'?'selected':''}>Open</option><option value="in_progress" ${current?.status==='in_progress'?'selected':''}>In progress</option><option value="done" ${current?.status==='done'?'selected':''}>Done</option><option value="cancelled" ${current?.status==='cancelled'?'selected':''}>Cancelled</option></select></label><label class="full">Note<textarea name="note" rows="4" placeholder="Write the next action clearly…">${app.escapeHtml(current?.note||'')}</textarea></label><label>Due date<input type="datetime-local" name="dueAt" value="${current?.dueAt?new Date(current.dueAt).toISOString().slice(0,16):''}"></label><label>Assign to<select name="assignedToId"><option value="">Unassigned</option>${admins.map(a=>`<option value="${app.escapeHtml(a.id)}" ${current?.assignedTo?.id===a.id?'selected':''}>${app.escapeHtml(a.name)}</option>`).join('')}</select></label></div></div><div class="admin-modal-footer"><button type="button" class="btn btn-outline" data-close-modal>Cancel</button><button class="btn btn-primary" type="submit">Save follow-up</button></div></form></div></div>`;
        const modal=root.firstElementChild;modal.addEventListener('click',e=>{if(e.target===modal||e.target.closest('[data-close-modal]'))root.innerHTML=''});document.getElementById('followupForm').addEventListener('submit',async e=>{e.preventDefault();const fd=new FormData(e.target);const payload={title:fd.get('title'),note:fd.get('note'),status:fd.get('status'),dueAt:fd.get('dueAt')?new Date(fd.get('dueAt')).toISOString():null,assignedToId:fd.get('assignedToId')||null};const btn=e.target.querySelector('button[type=submit]');btn.disabled=true;try{await app.apiRequest(id?`/admin/follow-ups/${encodeURIComponent(id)}`:'/admin/follow-ups',{method:id?'PUT':'POST',body:JSON.stringify(payload)});root.innerHTML='';app.showAlert('Follow-up saved.','success');await this.loadFollowUps();await this.loadOverview()}catch(err){btn.disabled=false;app.showAlert(err.message,'error')}});
    }

    async loadRoles(){if(!this.canOpenTeam())return this.renderLocked('rolesList','You do not have permission to view admin roles.');try{const r=await app.apiRequest('/admin/roles');this.roles=r.data?.roles||[];this.permissions=r.data?.permissions||[];this.renderRoles()}catch(e){this.renderLocked('rolesList',e.message)}}
    permissionLabel(p){return ({'dashboard.view':'View admin dashboard','users.view':'View user accounts','users.edit':'Edit account details','users.suspend':'Suspend / reactivate accounts','users.password_reset':'Start password resets','admins.manage':'Manage administrator accounts','roles.manage':'Create and edit admin roles','reports.review':'Review Trust & Safety reports','subscriptions.review':'Approve seller payments','settings.manage':'Manage platform settings','followups.manage':'Manage follow-ups','audit.view':'View admin audit log'})[p]||p}
    renderRoles(){const list=document.getElementById('rolesList');if(!this.roles.length){list.innerHTML='<div class="admin-empty"><i class="fas fa-user-shield"></i><strong>No custom admin roles yet</strong><p>Create roles such as Finance, Support or Trust & Safety.</p></div>';return;}list.innerHTML=this.roles.map(r=>`<article class="role-row"><div><div class="role-name">${app.escapeHtml(r.name)} <span class="role-count">${r._count?.users||0} assigned</span></div><div class="role-description">${app.escapeHtml(r.description||'No description')}</div><div class="permission-tags">${(r.permissions||[]).map(p=>`<span>${app.escapeHtml(this.permissionLabel(p))}</span>`).join('')}</div></div>${this.can('roles.manage') && this.canGrant(r.permissions) ? `<div class="admin-actions"><button class="btn btn-outline btn-sm" data-edit-role="${app.escapeHtml(r.id)}">Edit</button><button class="btn btn-outline btn-sm" data-delete-role="${app.escapeHtml(r.id)}">Delete</button></div>` : ''}</article>`).join('');list.querySelectorAll('[data-edit-role]').forEach(b=>b.addEventListener('click',()=>this.openRoleModal(b.dataset.editRole)));list.querySelectorAll('[data-delete-role]').forEach(b=>b.addEventListener('click',()=>this.deleteRole(b.dataset.deleteRole)))}
    async openRoleModal(id=null){const current=id?this.roles.find(r=>r.id===id):null;const root=document.getElementById('adminModalRoot');root.innerHTML=`<div class="admin-modal-backdrop" data-modal-close><div class="admin-modal"><div class="admin-modal-head"><div><span class="panel-kicker">Admin access</span><h2>${current?'Edit admin role':'Create admin role'}</h2></div><button class="btn btn-ghost btn-sm" data-close-modal><i class="fas fa-xmark"></i></button></div><form id="roleForm"><div class="admin-modal-body"><div class="admin-modal-grid"><label>Name<input name="name" value="${app.escapeHtml(current?.name||'')}" placeholder="Seller Support" required></label><label>Description<input name="description" value="${app.escapeHtml(current?.description||'')}" placeholder="Handles seller questions and account follow-ups"></label><div class="full"><span class="panel-kicker">Permissions</span><div class="permission-check-grid">${this.permissions.filter(p=>this.can(p)).map(p=>`<label class="permission-check"><input type="checkbox" name="permissions" value="${app.escapeHtml(p)}" ${(current?.permissions||[]).includes(p)?'checked':''}> ${app.escapeHtml(this.permissionLabel(p))}</label>`).join('')}</div></div></div></div><div class="admin-modal-footer"><button type="button" class="btn btn-outline" data-close-modal>Cancel</button><button type="submit" class="btn btn-primary">Save role</button></div></form></div></div>`;const modal=root.firstElementChild;modal.addEventListener('click',e=>{if(e.target===modal||e.target.closest('[data-close-modal]'))root.innerHTML=''});document.getElementById('roleForm').addEventListener('submit',async e=>{e.preventDefault();const fd=new FormData(e.target);const payload={name:fd.get('name'),description:fd.get('description'),permissions:fd.getAll('permissions')};const btn=e.target.querySelector('button[type=submit]');btn.disabled=true;try{await app.apiRequest(id?`/admin/roles/${encodeURIComponent(id)}`:'/admin/roles',{method:id?'PUT':'POST',body:JSON.stringify(payload)});root.innerHTML='';app.showAlert('Admin role saved.','success');await this.loadRoles()}catch(err){btn.disabled=false;app.showAlert(err.message,'error')}})}
    async deleteRole(id){const role=this.roles.find(r=>r.id===id);if(!role)return;const ok=await app.confirm({title:'Delete admin role?',message:'The role can only be deleted when it is not assigned to any administrator.',confirmText:'Delete role',tone:'danger'});if(!ok)return;try{await app.apiRequest(`/admin/roles/${encodeURIComponent(id)}`,{method:'DELETE'});app.showAlert('Admin role deleted.','success');await this.loadRoles()}catch(e){app.showAlert(e.message,'error')}}

    async loadSettings(){if(!this.can('settings.manage'))return this.renderLocked('settingsForm','You do not have permission to manage platform settings.');try{const r=await app.apiRequest('/admin/settings');const s=r.data||{};document.getElementById('settingsMtnCode').value=s.mtnMomoCode||'';document.getElementById('settingsMtnName').value=s.mtnMomoName||'';document.getElementById('settingsAirtelCode').value=s.airtelMoneyCode||'';document.getElementById('settingsAirtelName').value=s.airtelMoneyName||''}catch(e){app.showAlert(e.message,'error')}}
    async loadPaymentMethods() {
        if (!this.can('settings.manage')) return;
        const list = document.getElementById('paymentMethodsList'); if (!list) return;
        try { const r = await app.apiRequest('/admin/payment-methods'); this.paymentMethods = r.data || []; this.renderPaymentMethods(); }
        catch (e) { list.innerHTML = `<div class="admin-empty"><i class="fas fa-lock"></i><strong>Payment methods unavailable</strong><p>${app.escapeHtml(e.message)}</p></div>`; }
    }

    renderPaymentMethods() {
        const list = document.getElementById('paymentMethodsList'); const esc = app.escapeHtml;
        const rows = this.paymentMethods || [];
        if (!rows.length) { list.innerHTML = '<div class="admin-empty"><i class="fas fa-credit-card"></i><strong>No payment methods</strong><p>Add one so buyers have something to choose at checkout.</p></div>'; return; }
        list.innerHTML = rows.map(m => `<article class="role-row"><div><div class="role-name"><i class="fas ${esc(m.icon || 'fa-money-bill')}"></i> ${esc(m.label)} <span class="role-count">${esc(m.code)}</span></div><div class="permission-tags"><span class="admin-chip ${m.isActive ? 'active' : 'suspended'}">${m.isActive ? 'On' : 'Off'}</span><span>${esc(m.currency)}</span><span>${esc((m.allowedCountries || []).join(', ') || 'No countries')}</span><span>${m.environment === 'test' ? 'Test mode' : 'Live'}</span></div></div><div class="admin-actions"><button class="btn btn-outline btn-sm" data-toggle-method="${esc(m.id)}">${m.isActive ? 'Turn off' : 'Turn on'}</button><button class="btn btn-outline btn-sm" data-edit-method="${esc(m.id)}">Edit</button><button class="btn btn-outline btn-sm" data-delete-method="${esc(m.id)}">Delete</button></div></article>`).join('');
        list.querySelectorAll('[data-toggle-method]').forEach(b => b.addEventListener('click', () => this.togglePaymentMethod(b.dataset.toggleMethod)));
        list.querySelectorAll('[data-edit-method]').forEach(b => b.addEventListener('click', () => this.openPaymentMethodModal(b.dataset.editMethod)));
        list.querySelectorAll('[data-delete-method]').forEach(b => b.addEventListener('click', () => this.deletePaymentMethod(b.dataset.deleteMethod)));
    }

    async togglePaymentMethod(id) {
        const m = (this.paymentMethods || []).find(x => x.id === id); if (!m) return;
        try { await app.apiRequest(`/admin/payment-methods/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ isActive: !m.isActive }) }); await this.loadPaymentMethods(); }
        catch (e) { app.showAlert(e.message, 'error'); }
    }

    async deletePaymentMethod(id) {
        const m = (this.paymentMethods || []).find(x => x.id === id); if (!m) return;
        const ok = await app.confirm({ title: 'Delete payment method?', message: `Buyers will no longer see ${m.label}. Turning it off instead keeps it for later.`, confirmText: 'Delete', tone: 'danger' });
        if (!ok) return;
        try { await app.apiRequest(`/admin/payment-methods/${encodeURIComponent(id)}`, { method: 'DELETE' }); app.showAlert('Payment method deleted.', 'success'); await this.loadPaymentMethods(); }
        catch (e) { app.showAlert(e.message, 'error'); }
    }

    openPaymentMethodModal(id = null) {
        const m = id ? (this.paymentMethods || []).find(x => x.id === id) : null; const esc = app.escapeHtml;
        const root = document.getElementById('adminModalRoot');
        root.innerHTML = `<div class="admin-modal-backdrop" data-modal-close><div class="admin-modal" role="dialog" aria-modal="true" aria-labelledby="pmTitle"><div class="admin-modal-head"><div><span class="panel-kicker">Checkout</span><h2 id="pmTitle">${m ? 'Edit payment method' : 'Add payment method'}</h2></div><button class="btn btn-ghost btn-sm" data-close-modal aria-label="Close"><i class="fas fa-xmark"></i></button></div><form id="pmForm"><div class="admin-modal-body"><div class="admin-modal-grid"><label>Code<input name="code" value="${esc(m?.code || '')}" ${m ? 'readonly' : 'required'} placeholder="mtnMomo" pattern="[a-zA-Z][a-zA-Z0-9]*"></label><label>Label<input name="label" value="${esc(m?.label || '')}" required maxlength="60" placeholder="MTN Mobile Money"></label><label>Icon (Font Awesome class)<input name="icon" value="${esc(m?.icon || 'fa-money-bill')}" maxlength="60"></label><label>Currency<input name="currency" value="${esc(m?.currency || 'UGX')}" maxlength="10"></label><label>Allowed countries (comma separated)<input name="countries" value="${esc((m?.allowedCountries || ['UG']).join(', '))}" placeholder="UG, KE"></label><label>Environment<select name="environment"><option value="live" ${m?.environment !== 'test' ? 'selected' : ''}>Live</option><option value="test" ${m?.environment === 'test' ? 'selected' : ''}>Test</option></select></label><label>Order in list<input name="sortOrder" type="number" step="1" value="${Number(m?.sortOrder || 0)}"></label><label class="permission-check"><input type="checkbox" name="isActive" ${!m || m.isActive ? 'checked' : ''}> Available at checkout</label></div></div><div class="admin-modal-footer"><button type="button" class="btn btn-outline" data-close-modal>Cancel</button><button type="submit" class="btn btn-primary">Save method</button></div></form></div></div>`;
        const modal = root.firstElementChild;
        modal.addEventListener('click', e => { if (e.target === modal || e.target.closest('[data-close-modal]')) root.innerHTML = ''; });
        document.getElementById('pmForm').addEventListener('submit', async e => {
            e.preventDefault(); const fd = new FormData(e.target);
            const payload = { label: fd.get('label'), icon: fd.get('icon') || 'fa-money-bill', currency: String(fd.get('currency') || 'UGX').toUpperCase(), allowedCountries: String(fd.get('countries') || '').split(',').map(c => c.trim().toUpperCase()).filter(Boolean), environment: fd.get('environment'), sortOrder: parseInt(fd.get('sortOrder'), 10) || 0, isActive: fd.has('isActive') };
            if (!m) payload.code = fd.get('code');
            const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
            try { await app.apiRequest(m ? `/admin/payment-methods/${encodeURIComponent(m.id)}` : '/admin/payment-methods', { method: m ? 'PUT' : 'POST', body: JSON.stringify(payload) }); root.innerHTML = ''; app.showAlert('Payment method saved.', 'success'); await this.loadPaymentMethods(); }
            catch (err) { btn.disabled = false; app.showAlert(err.message, 'error'); }
        });
    }

    async saveSettings(e){e.preventDefault();if(!this.can('settings.manage'))return;const btn=document.getElementById('settingsSaveBtn');btn.disabled=true;try{await app.apiRequest('/admin/settings',{method:'PUT',body:JSON.stringify({mtnMomoCode:document.getElementById('settingsMtnCode').value.trim(),mtnMomoName:document.getElementById('settingsMtnName').value.trim(),airtelMoneyCode:document.getElementById('settingsAirtelCode').value.trim(),airtelMoneyName:document.getElementById('settingsAirtelName').value.trim()})});app.showAlert('Platform payment settings saved.','success')}catch(e){app.showAlert(e.message,'error')}finally{btn.disabled=false}}

    async loadAudit(){if(!this.can('audit.view'))return this.renderLocked('auditList','You do not have permission to view the audit log.');const list=document.getElementById('auditList');list.innerHTML='<div class="admin-loading"><i class="fas fa-spinner fa-spin"></i> Loading audit log…</div>';try{const r=await app.apiRequest('/admin/audit');const rows=r.data||[];list.innerHTML=rows.length?rows.map(a=>`<article class="audit-row"><div class="audit-main"><strong>${app.escapeHtml(a.action)}</strong><small>By ${app.escapeHtml(a.actor?.name||'Administrator')}${a.targetUser?` · ${app.escapeHtml(a.targetUser.email)}`:''}</small></div><span class="audit-time">${app.escapeHtml(app.formatDate(a.createdAt))}</span></article>`).join(''):'<div class="admin-empty"><i class="fas fa-clock-rotate-left"></i><strong>No admin actions recorded yet</strong></div>'}catch(e){list.innerHTML=`<div class="admin-empty"><i class="fas fa-lock"></i><strong>Audit unavailable</strong><p>${app.escapeHtml(e.message)}</p></div>`}}

    renderLocked(id,msg){const el=document.getElementById(id);if(el)el.innerHTML=`<div class="admin-empty"><i class="fas fa-lock"></i><strong>Access restricted</strong><p>${app.escapeHtml(msg)}</p></div>`}
}

document.addEventListener('DOMContentLoaded', () => { window.adminConsole = new AdminConsole(); });
