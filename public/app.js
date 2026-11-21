/* T-Pic Manager — front-end (vanilla JS, no build step, no external files) */
'use strict';
(function () {
  const $app = document.getElementById('app');
  const $toast = document.getElementById('toast');
  const MB = 1024 * 1024;
  const OK_TYPES = /^image\/(jpeg|png|gif|webp)$/;

  const state = {
    info: null,
    me: null,
    settings: null,
    list: { q: '', sort: 'new', uploader: '', page: 1 },
    data: null,
    uploads: [],
  };
  const els = {}; // live nodes of the current view
  let uid = 0;
  const nextId = (p) => `${p}-${++uid}`;

  // ------------------------------------------------------------ DOM helpers
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'value') el.value = v;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
  }

  const ICONS = {
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>',
    x: '<path d="M18 6L6 18"/><path d="M6 6l12 12"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    alert: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    external: '<path d="M14 3h7v7"/><path d="M10 14L21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
  };
  function icon(name) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('class', 'icon');
    s.innerHTML = ICONS[name] || '';
    return s;
  }

  // ------------------------------------------------------------ formatting
  const dtf = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fmtDate = (ms) => (ms ? dtf.format(new Date(ms)) : '—');
  function fmtBytes(n) {
    if (n == null) return '—';
    if (n < 1024) return `${n} B`;
    if (n < MB) return `${Math.round(n / 1024)} KB`;
    if (n < 1024 * MB) return `${(n / MB).toFixed(1)} MB`;
    return `${(n / 1024 / MB).toFixed(1)} GB`;
  }
  const dims = (img) => (img.width && img.height ? `${img.width}×${img.height}` : '—');
  const who = (img) => (img.uploader ? img.uploader.username : 'ผู้ใช้ที่ถูกลบ');
  const stripExt = (name) => name.replace(/\.[A-Za-z0-9]{1,5}$/, '') || name;
  const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const thumbSrc = (img) => `${img.path}?v=${img.version}`;
  function randomPassword(len = 10) {
    const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const buf = new Uint32Array(len);
    crypto.getRandomValues(buf);
    return Array.from(buf, (x) => abc[x % abc.length]).join('');
  }

  // ------------------------------------------------------------ toast
  let toastTimer;
  function toast(msg, isError) {
    $toast.textContent = msg;
    $toast.className = isError ? 'toast err' : 'toast';
    $toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $toast.hidden = true; }, isError ? 4500 : 2500);
  }

  // ------------------------------------------------------------ server calls
  async function api(method, path, body, opts = {}) {
    const headers = { 'X-Requested-With': 't-pic' };
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' });
    } catch {
      throw new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้');
    }
    let data = null;
    try { data = await res.json(); } catch { /* not json */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `เกิดข้อผิดพลาด (${res.status})`);
      err.status = res.status;
      if (res.status === 401 && !opts.quiet401) {
        clearSessionState();
        closeAllModals();
        route();
      }
      throw err;
    }
    return data;
  }

  function xhrUpload(method, url, file, name, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open(method, url);
      x.setRequestHeader('X-Requested-With', 't-pic');
      x.setRequestHeader('X-Filename', encodeURIComponent(name));
      x.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      x.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      x.onload = () => {
        let d = null;
        try { d = JSON.parse(x.responseText); } catch { /* ignore */ }
        if (x.status >= 200 && x.status < 300) return resolve(d);
        if (x.status === 401) { clearSessionState(); closeAllModals(); route(); }
        reject(new Error((d && d.error) || `อัปโหลดไม่สำเร็จ (${x.status})`));
      };
      x.onerror = () => reject(new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ หรือไฟล์ใหญ่เกินกำหนด'));
      x.send(file);
    });
  }

  async function loadSettings() {
    try { state.settings = await api('GET', '/api/settings'); } catch { state.settings = state.settings || { max_upload_mb: 10 }; }
  }

  /** Copy text. navigator.clipboard only works on https/localhost, so fall back for plain-http LAN use. */
  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
    }
    const ta = h('textarea', { readonly: true, 'aria-hidden': 'true' });
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    (document.querySelector('.backdrop:last-of-type') || document.body).append(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }

  async function copyWithFeedback(btn, text, label) {
    const ok = await copyText(text);
    btn.focus();
    if (!ok) return toast('คัดลอกไม่สำเร็จ กรุณาเลือกข้อความแล้วกด Ctrl+C', true);
    const old = Array.from(btn.childNodes);
    const oldClass = btn.className;
    btn.className = oldClass.replace('btn-primary', '') + ' btn-ok';
    btn.replaceChildren(icon('check'), 'คัดลอกแล้ว');
    toast(label ? `คัดลอก${label}แล้ว` : 'คัดลอกแล้ว');
    setTimeout(() => { btn.className = oldClass; btn.replaceChildren(...old); }, 1800);
  }

  // ------------------------------------------------------------ modals
  const modalStack = [];
  function openModal(node, { role = 'dialog', labelledby, onClose } = {}) {
    const prevFocus = document.activeElement;
    node.setAttribute('role', role);
    node.setAttribute('aria-modal', 'true');
    if (labelledby) node.setAttribute('aria-labelledby', labelledby);
    const backdrop = h('div', { class: 'backdrop' }, node);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
    const entry = { close, node };
    function close() {
      const i = modalStack.indexOf(entry);
      if (i < 0) return;
      modalStack.splice(i, 1);
      backdrop.remove();
      if (!modalStack.length) document.body.style.overflow = '';
      if (onClose) onClose();
      if (prevFocus && document.contains(prevFocus)) prevFocus.focus();
    }
    modalStack.push(entry);
    document.body.append(backdrop);
    document.body.style.overflow = 'hidden';
    const first = node.querySelector('[autofocus]') || node.querySelector('button, [href], input, select');
    if (first) first.focus();
    return close;
  }
  function closeAllModals() {
    while (modalStack.length) modalStack[modalStack.length - 1].close();
  }
  document.addEventListener('keydown', (e) => {
    const top = modalStack[modalStack.length - 1];
    if (!top) return;
    if (e.key === 'Escape') { e.preventDefault(); top.close(); return; }
    if (e.key === 'Tab') {
      const f = Array.from(top.node.querySelectorAll('button:not([disabled]), [href], input:not([type=hidden]):not([hidden]), select'))
        .filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  function confirmDialog({ title, body, confirmLabel, danger = true, onConfirm }) {
    const tid = nextId('dlg');
    const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const okBtn = h('button', { type: 'button', class: danger ? 'btn btn-danger btn-lg' : 'btn btn-primary btn-lg' }, confirmLabel);
    const cancelBtn = h('button', { type: 'button', class: 'btn btn-lg', autofocus: true }, 'ยกเลิก');
    const node = h('div', { class: 'dialog' },
      h('div', { class: 'dialog-head' },
        danger ? h('span', { class: 'dialog-icon' }, icon('alert')) : null,
        h('div', { class: 'field' }, h('h2', { id: tid }, title))),
      body, err,
      h('div', { class: 'dialog-actions' }, cancelBtn, okBtn));
    const close = openModal(node, { role: 'alertdialog', labelledby: tid });
    cancelBtn.addEventListener('click', close);
    okBtn.addEventListener('click', async () => {
      okBtn.disabled = true;
      try {
        await onConfirm();
        close();
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
        okBtn.disabled = false;
      }
    });
  }

  // ------------------------------------------------------------ routing
  function route() {
    closeAllModals();
    for (const k of Object.keys(els)) delete els[k];
    if (!state.me) return renderLogin();
    if (state.me.must_change_pw) return renderForceChange();
    const hash = location.hash || '#/';
    if (hash.startsWith('#/users')) {
      if (state.me.role === 'admin') return renderUsers();
      location.hash = '#/';
      return;
    }
    return renderGallery();
  }
  window.addEventListener('hashchange', route);

  function brand(href) {
    return h(href ? 'a' : 'div', { class: 'brand', href },
      h('span', { class: 'brand-mark' }, icon('image')), 'T-Pic Manager');
  }

  function topbar(active) {
    const me = state.me;
    return h('header', { class: 'topbar' },
      h('div', { class: 'topbar-inner' },
        brand('#/'),
        h('nav', { class: 'nav', 'aria-label': 'เมนูหลัก' },
          h('a', { href: '#/', class: active === 'gallery' ? 'active' : null, 'aria-current': active === 'gallery' ? 'page' : null }, 'รูปภาพ'),
          me.role === 'admin'
            ? h('a', { href: '#/users', class: active === 'users' ? 'active' : null, 'aria-current': active === 'users' ? 'page' : null }, 'ผู้ใช้ & ตั้งค่า')
            : null),
        h('div', { class: 'userbox' },
          h('span', { class: 'avatar', 'aria-hidden': 'true' }, (me.username || '?')[0]),
          h('span', null, me.display_name || me.username),
          me.role === 'admin' ? h('span', { class: 'badge badge-admin' }, 'admin') : null,
          h('button', { type: 'button', class: 'btn', onclick: openChangePassword }, 'เปลี่ยนรหัสผ่าน'),
          h('button', { type: 'button', class: 'btn', onclick: logout }, 'ออกจากระบบ'))));
  }

  function clearSessionState() {
    state.me = null;
    state.data = null;
    state.uploads = state.uploads.filter((x) => x.status === 'run' || x.status === 'wait');
    state.list = { q: '', sort: 'new', uploader: '', page: 1 };
  }

  async function logout() {
    try { await api('POST', '/api/logout'); } catch { /* ignore */ }
    clearSessionState();
    location.hash = '#/';
    route();
  }

  // ------------------------------------------------------------ login
  function renderLogin() {
    const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const user = h('input', { class: 'input', id: 'l-user', name: 'username', autocomplete: 'username', required: true });
    const pass = h('input', { class: 'input', id: 'l-pass', name: 'password', type: 'password', autocomplete: 'current-password', required: true });
    const btn = h('button', { type: 'submit', class: 'btn btn-primary btn-lg' }, 'เข้าสู่ระบบ');
    const form = h('form', { class: 'auth-card', 'aria-labelledby': 'login-title' },
      h('h1', { id: 'login-title' }, 'เข้าสู่ระบบ'),
      h('div', { class: 'field' }, h('label', { for: 'l-user' }, 'ชื่อผู้ใช้'), user),
      h('div', { class: 'field' }, h('label', { for: 'l-pass' }, 'รหัสผ่าน'), pass),
      err, btn,
      state.info && state.info.setup_pending
        ? h('p', { class: 'hint-box' }, 'ติดตั้งครั้งแรก: ผู้ใช้ ', h('strong', null, 'admin'), ' รหัส ', h('strong', null, 'admin'))
        : null);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      btn.disabled = true;
      try {
        const r = await api('POST', '/api/login', { username: user.value.trim(), password: pass.value }, { quiet401: true });
        state.me = r.user;
        if (!state.me.must_change_pw) await loadSettings();
        if (location.hash !== '#/' && location.hash !== '' && !location.hash.startsWith('#/users')) location.hash = '#/';
        route();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        btn.disabled = false;
        pass.select();
      }
    });
    $app.replaceChildren(h('div', { class: 'auth-wrap' },
      brand(null), form,
      h('p', { class: 'footer-note' }, `T-Pic Manager v${(state.info && state.info.version) || ''}`)));
    user.focus();
  }

  function passwordFields(prefix) {
    const cur = h('input', { class: 'input', id: `${prefix}-cur`, type: 'password', autocomplete: 'current-password', required: true });
    const nw = h('input', { class: 'input', id: `${prefix}-new`, type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
    const again = h('input', { class: 'input', id: `${prefix}-again`, type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
    const nodes = [
      h('div', { class: 'field' }, h('label', { for: `${prefix}-cur` }, 'รหัสผ่านปัจจุบัน'), cur),
      h('div', { class: 'field' }, h('label', { for: `${prefix}-new` }, 'รหัสผ่านใหม่ (อย่างน้อย 8 ตัว)'), nw),
      h('div', { class: 'field' }, h('label', { for: `${prefix}-again` }, 'ยืนยันรหัสผ่านใหม่'), again),
    ];
    async function submit() {
      if (nw.value.length < 8) throw new Error('รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร');
      if (nw.value !== again.value) throw new Error('รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน');
      const r = await api('POST', '/api/change-password', { current: cur.value, new: nw.value });
      state.me = r.user;
    }
    return { nodes, submit, first: cur };
  }

  function renderForceChange() {
    const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const pf = passwordFields('fc');
    const btn = h('button', { type: 'submit', class: 'btn btn-dark btn-lg' }, 'บันทึกและเข้าใช้งาน');
    const form = h('form', { class: 'auth-card warn', 'aria-labelledby': 'fc-title' },
      h('div', null,
        h('h1', { id: 'fc-title' }, 'ตั้งรหัสผ่านใหม่'),
        h('p', { class: 'warn-text' }, `สวัสดี ${state.me.username} — ต้องเปลี่ยนรหัสผ่านก่อนเริ่มใช้งาน`)),
      pf.nodes, err, btn,
      h('button', { type: 'button', class: 'btn', onclick: logout }, 'ออกจากระบบ'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      btn.disabled = true;
      try {
        await pf.submit();
        await loadSettings();
        toast('เปลี่ยนรหัสผ่านแล้ว');
        location.hash = '#/';
        route();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        btn.disabled = false;
      }
    });
    $app.replaceChildren(h('div', { class: 'auth-wrap' }, brand(null), form));
    pf.first.focus();
  }

  function openChangePassword() {
    const tid = nextId('cp');
    const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const pf = passwordFields(nextId('cpf'));
    const save = h('button', { type: 'submit', class: 'btn btn-primary btn-lg' }, 'บันทึก');
    const cancel = h('button', { type: 'button', class: 'btn btn-lg' }, 'ยกเลิก');
    const form = h('form', { class: 'dialog' }, h('h2', { id: tid }, 'เปลี่ยนรหัสผ่าน'), pf.nodes, err,
      h('div', { class: 'dialog-actions' }, cancel, save));
    const close = openModal(form, { labelledby: tid });
    cancel.addEventListener('click', close);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      save.disabled = true;
      try {
        await pf.submit();
        close();
        toast('เปลี่ยนรหัสผ่านแล้ว');
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        save.disabled = false;
      }
    });
  }

  // ------------------------------------------------------------ gallery
  function renderGallery() {
    const L = state.list;
    const maxMb = (state.settings && state.settings.max_upload_mb) || 10;

    const fileInput = h('input', {
      type: 'file', accept: 'image/jpeg,image/png,image/gif,image/webp', multiple: true, hidden: true,
      onchange: (e) => { queueFiles(Array.from(e.target.files)); e.target.value = ''; },
    });
    els.dropzone = h('section', { class: 'dropzone', 'aria-label': 'อัปโหลดรูป' },
      h('span', { class: 'drop-icon' }, icon('upload')),
      h('p', { class: 'big' }, 'ลากไฟล์รูปมาวางที่นี่ หรือ ',
        h('button', { type: 'button', class: 'btn-link', onclick: () => fileInput.click() }, 'เลือกไฟล์')),
      h('p', { class: 'small' }, 'วางจากคลิปบอร์ดได้ด้วย Ctrl+V · เลือกได้หลายไฟล์พร้อมกัน'),
      h('p', { class: 'small' }, `รองรับ JPG, PNG, GIF, WebP · สูงสุด ${maxMb} MB ต่อไฟล์`));
    els.uploads = h('section', { class: 'uploads', 'aria-label': 'รายการอัปโหลด', hidden: true });
    els.stats = h('p', null, 'กำลังโหลด…');

    let debounce;
    const search = h('input', {
      type: 'search', placeholder: 'ค้นหาจากชื่อไฟล์…', 'aria-label': 'ค้นหารูป', value: L.q,
      oninput: (e) => {
        clearTimeout(debounce);
        debounce = setTimeout(() => { L.q = e.target.value.trim(); L.page = 1; loadImages(); }, 300);
      },
    });
    const sortSel = h('select', { class: 'select', onchange: (e) => { L.sort = e.target.value; L.page = 1; loadImages(); } },
      [['new', 'ใหม่สุดก่อน'], ['old', 'เก่าสุดก่อน'], ['name', 'ชื่อ ก–ฮ / A–Z'], ['size', 'ขนาดใหญ่สุด']]
        .map(([v, t]) => h('option', { value: v, selected: L.sort === v }, t)));
    els.uploaderSel = h('select', { class: 'select', onchange: (e) => { L.uploader = e.target.value; L.page = 1; loadImages(); } },
      h('option', { value: '' }, 'ทั้งหมด'));
    els.grid = h('div', { class: 'grid', 'aria-busy': 'true' });
    els.pager = h('nav', { class: 'pager', 'aria-label': 'เลือกหน้า' });

    $app.replaceChildren(
      topbar('gallery'),
      h('main', { class: 'container' },
        h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'คลังรูปภาพ'), els.stats)),
        els.dropzone, fileInput, els.uploads,
        h('div', { class: 'toolbar' },
          h('div', { class: 'search' }, icon('search'), search),
          h('label', { class: 'inline-label' }, 'เรียงตาม', sortSel),
          h('label', { class: 'inline-label' }, 'ผู้อัปโหลด', els.uploaderSel),
          h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'โหลดใหม่', title: 'โหลดใหม่', onclick: () => loadImages() }, icon('refresh'))),
        els.grid, els.pager));
    renderUploads();
    loadImages();
  }

  let listReq = 0;
  async function loadImages() {
    if (!els.grid) return;
    const L = state.list;
    const p = new URLSearchParams({ sort: L.sort, page: String(L.page), limit: '40' });
    if (L.q) p.set('q', L.q);
    if (L.uploader) p.set('uploader', L.uploader);
    const my = ++listReq;
    els.grid.setAttribute('aria-busy', 'true');
    try {
      const d = await api('GET', `/api/images?${p}`);
      if (my !== listReq || !els.grid) return;
      state.data = d;
      L.page = d.page;
      renderGrid();
    } catch (e) {
      if (e.status !== 401) toast(e.message, true);
    }
  }

  function renderGrid() {
    const d = state.data;
    const L = state.list;
    els.stats.textContent = `${d.stats.count.toLocaleString('th-TH')} รูป · ใช้พื้นที่ ${fmtBytes(d.stats.bytes)}`;

    // uploader filter options
    const opts = [h('option', { value: '' }, 'ทั้งหมด')].concat(
      d.uploaders.map((u) => h('option', { value: String(u.id), selected: String(u.id) === L.uploader }, u.username)));
    els.uploaderSel.replaceChildren(...opts);
    els.uploaderSel.value = L.uploader;

    els.grid.removeAttribute('aria-busy');
    if (!d.items.length) {
      els.grid.className = '';
      els.grid.replaceChildren(h('div', { class: 'empty' },
        L.q || L.uploader ? 'ไม่พบรูปที่ตรงกับการค้นหา' : 'ยังไม่มีรูปภาพ — ลากไฟล์มาวางด้านบนเพื่อเริ่มต้น'));
    } else {
      els.grid.className = 'grid';
      els.grid.replaceChildren(...d.items.map(card));
    }

    // pager
    els.pager.replaceChildren();
    if (d.pages > 1) {
      const go = (n) => { L.page = n; loadImages(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
      els.pager.append(h('button', { type: 'button', class: 'btn', disabled: d.page <= 1, onclick: () => go(d.page - 1) }, 'ก่อนหน้า'));
      const pages = new Set([1, d.pages, d.page - 1, d.page, d.page + 1]);
      let last = 0;
      for (const n of Array.from(pages).filter((n) => n >= 1 && n <= d.pages).sort((a, b) => a - b)) {
        if (n - last > 1) els.pager.append(h('span', { class: 'muted' }, '…'));
        els.pager.append(h('button', {
          type: 'button', class: n === d.page ? 'btn current' : 'btn', 'aria-current': n === d.page ? 'page' : null, onclick: () => go(n),
        }, String(n)));
        last = n;
      }
      els.pager.append(h('button', { type: 'button', class: 'btn', disabled: d.page >= d.pages, onclick: () => go(d.page + 1) }, 'ถัดไป'));
    }
  }

  function card(img) {
    const copyBtn = h('button', { type: 'button', class: 'btn btn-primary' }, icon('copy'), 'คัดลอกลิงก์');
    copyBtn.addEventListener('click', () => copyWithFeedback(copyBtn, img.url, 'ลิงก์'));
    return h('article', { class: 'card' },
      h('button', { type: 'button', class: 'thumb', 'aria-label': `ดูรายละเอียด ${img.name}`, onclick: () => openDetail(img) },
        h('img', { src: thumbSrc(img), alt: '', loading: 'lazy', decoding: 'async' })),
      h('div', { class: 'card-body' },
        h('span', { class: 'card-name', title: img.name }, img.name),
        h('span', { class: 'card-meta' }, `${fmtBytes(img.size)} · ${dims(img)} · ${who(img)}`),
        h('span', { class: 'card-meta' }, fmtDate(img.created_at))),
      h('div', { class: 'card-actions' },
        copyBtn,
        img.can_edit
          ? h('button', { type: 'button', class: 'btn btn-icon btn-danger-outline', 'aria-label': `ลบ ${img.name}`, title: 'ลบรูป', onclick: () => confirmDelete(img) }, icon('trash'))
          : null));
  }

  // ------------------------------------------------------------ upload queue
  let uploading = false;

  function pastedName(file) {
    const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    return `pasted-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.${ext}`;
  }

  function queueFiles(files, fromPaste) {
    const maxMb = (state.settings && state.settings.max_upload_mb) || 10;
    for (const f of files) {
      const name = fromPaste && (!f.name || /^image\.\w+$/i.test(f.name)) ? pastedName(f) : (f.name || 'image');
      const item = { name, file: f, progress: 0, status: 'wait', msg: 'รอคิว' };
      if (f.type && !OK_TYPES.test(f.type)) { item.status = 'err'; item.msg = 'ไม่ใช่ไฟล์รูปภาพที่รองรับ — ไม่ได้อัปโหลด'; }
      else if (f.size > maxMb * MB) { item.status = 'err'; item.msg = `ใหญ่เกิน ${maxMb} MB — ไม่ได้อัปโหลด`; }
      state.uploads.push(item);
    }
    renderUploads();
    runQueue();
  }

  async function runQueue() {
    if (uploading) return;
    uploading = true;
    let added = 0;
    try {
      for (;;) {
        const item = state.uploads.find((x) => x.status === 'wait');
        if (!item) break;
        item.status = 'run';
        item.msg = 'กำลังอัปโหลด…';
        renderUploads();
        try {
          await xhrUpload('POST', '/api/images', item.file, item.name, (p) => {
            item.progress = p;
            item.msg = `${fmtBytes(item.file.size)} · ${Math.round(p * 100)}%`;
            renderUploads();
          });
          item.status = 'ok';
          item.msg = 'อัปโหลดแล้ว';
          added++;
        } catch (e) {
          item.status = 'err';
          item.msg = e.message;
        }
        renderUploads();
      }
    } finally {
      uploading = false;
    }
    if (added) {
      toast(`อัปโหลดสำเร็จ ${added} รูป`);
      if (state.list.sort === 'new') state.list.page = 1;
      loadImages();
      setTimeout(() => {
        state.uploads = state.uploads.filter((x) => x.status !== 'ok');
        renderUploads();
      }, 4000);
    }
  }

  function renderUploads() {
    if (!els.uploads) return;
    const items = state.uploads;
    els.uploads.hidden = items.length === 0;
    els.uploads.replaceChildren(...items.map((it) => {
      const cls = it.status === 'err' ? 'status err' : it.status === 'ok' ? 'status ok' : 'status';
      const bar = h('div', { class: 'progress' }, h('div'));
      bar.firstChild.style.width = `${Math.round((it.status === 'ok' ? 1 : it.progress) * 100)}%`;
      return h('div', { class: 'upload-row' },
        h('span', { class: 'name', title: it.name }, it.name),
        h('span', { class: cls }, it.msg),
        it.status === 'err' || it.status === 'ok'
          ? h('button', {
            type: 'button', class: 'btn btn-icon', 'aria-label': `ปิด ${it.name}`,
            onclick: () => { state.uploads = state.uploads.filter((x) => x !== it); renderUploads(); },
          }, icon('x'))
          : null,
        it.status === 'run' || it.status === 'wait' ? bar : null);
    }));
  }

  // drag & drop anywhere on the gallery page
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!els.dropzone || !hasFiles(e)) return;
    dragDepth++;
    els.dropzone.classList.add('drag');
  });
  window.addEventListener('dragleave', () => {
    if (!els.dropzone) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) els.dropzone.classList.remove('drag');
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = els.dropzone && !modalStack.length ? 'copy' : 'none';
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    if (!els.dropzone || modalStack.length) return;
    els.dropzone.classList.remove('drag');
    queueFiles(Array.from(e.dataTransfer.files));
  });

  // paste images (Ctrl+V)
  document.addEventListener('paste', (e) => {
    if (!els.dropzone || modalStack.length) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && !(e.clipboardData && e.clipboardData.files.length)) return;
    const files = e.clipboardData ? Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/')) : [];
    if (!files.length) return;
    e.preventDefault();
    queueFiles(files, true);
  });

  // ------------------------------------------------------------ detail / copy / replace
  function openDetail(img) {
    let cur = img;
    const tid = nextId('detail');
    const preview = h('img', { alt: '' });
    const openFull = h('a', { class: 'open-full', target: '_blank', rel: 'noopener' }, 'เปิดรูปเต็มในแท็บใหม่ ↗');
    const title = h('h2', { id: tid });
    const sub = h('div', { class: 'sub' });
    const stats = h('dl', { class: 'stats' });

    const fields = [
      { key: 'url', label: 'URL ของรูป', make: (u) => u },
      { key: 'html', label: 'HTML (แท็ก img)', make: (u, alt) => `<img src="${u}" alt="${escAttr(alt)}">` },
      { key: 'md', label: 'Markdown', make: (u, alt) => `![${alt.replace(/[[\]]/g, '')}](${u})` },
    ].map((f) => {
      const id = nextId(`f-${f.key}`);
      const input = h('input', { class: 'input mono', id, readonly: true, onfocus: (e) => e.target.select() });
      const btn = h('button', { type: 'button', class: 'btn btn-primary' }, icon('copy'), 'คัดลอก');
      btn.addEventListener('click', () => copyWithFeedback(btn, input.value, f.label));
      return { ...f, input, node: h('div', { class: 'field' }, h('label', { for: id }, f.label), h('div', { class: 'copy-row' }, input, btn)) };
    });

    const replaceInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/gif,image/webp', hidden: true });
    const replaceBtn = h('button', { type: 'button', class: 'btn btn-lg', onclick: () => replaceInput.click() }, icon('refresh'), 'แทนที่รูป (ลิงก์เดิม)');
    const deleteBtn = h('button', { type: 'button', class: 'btn btn-lg btn-danger-outline' }, icon('trash'), 'ลบรูปนี้');
    const closeBtn = h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'ปิด' }, icon('x'));
    const renameBtn = cur.can_edit
      ? h('button', { type: 'button', class: 'btn btn-icon btn-ghost', 'aria-label': 'แก้ไขชื่อรูป', title: 'แก้ไขชื่อรูป' }, icon('pencil'))
      : null;
    const titleRow = h('div', { class: 'title-row' }, title, renameBtn);

    function fill() {
      preview.src = thumbSrc(cur);
      preview.alt = cur.name;
      openFull.href = thumbSrc(cur);
      title.textContent = cur.name;
      sub.textContent = `อัปโหลดโดย ${who(cur)} · ${fmtDate(cur.created_at)}` +
        (cur.version > 1 ? ` · แทนที่ล่าสุด ${fmtDate(cur.updated_at)}` : '');
      stats.replaceChildren(
        h('div', null, h('dt', null, 'ขนาดไฟล์'), h('dd', null, fmtBytes(cur.size))),
        h('div', null, h('dt', null, 'ขนาดภาพ'), h('dd', null, dims(cur))),
        h('div', null, h('dt', null, 'ชนิด'), h('dd', null, cur.mime.replace('image/', '').toUpperCase())));
      const alt = stripExt(cur.name);
      for (const f of fields) f.input.value = f.make(cur.url, alt);
    }

    const node = h('section', { class: 'modal' },
      h('div', { class: 'modal-preview' }, preview, openFull),
      h('div', { class: 'modal-info' },
        h('div', { class: 'modal-head' }, h('div', { class: 'field head-field' }, titleRow, sub), closeBtn),
        stats,
        h('div', { class: 'copy-list' }, h('h3', null, 'คัดลอกไปใช้งาน'), fields.map((f) => f.node)),
        cur.can_edit
          ? h('div', { class: 'modal-foot' }, replaceBtn, replaceInput, deleteBtn)
          : h('p', { class: 'muted' }, 'รูปนี้แก้ไขหรือลบได้เฉพาะผู้อัปโหลดและ admin')));
    fill();
    const close = openModal(node, { labelledby: tid });
    closeBtn.addEventListener('click', close);

    // ---- rename (display/search name only; the link stays the same)
    function startRename() {
      const id = nextId('rn');
      const input = h('input', { class: 'input', id, value: cur.name, maxlength: 200, autocomplete: 'off' });
      const save = h('button', { type: 'submit', class: 'btn btn-primary' }, 'บันทึก');
      const cancel = h('button', { type: 'button', class: 'btn' }, 'ยกเลิก');
      const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
      const form = h('form', { class: 'rename-form' },
        h('label', { for: id, class: 'sr-only' }, 'ชื่อรูปใหม่'),
        h('div', { class: 'rename-row' }, input, save, cancel),
        h('span', { class: 'hint' }, 'ชื่อนี้ใช้สำหรับค้นหาและแสดงผล — ลิงก์รูปไม่เปลี่ยน'),
        err);
      const stop = () => {
        if (form.isConnected) form.replaceWith(titleRow);
        if (renameBtn) renameBtn.focus();
      };
      cancel.addEventListener('click', stop);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stop(); }
      });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const value = input.value.trim();
        if (!value) { err.textContent = 'กรุณาใส่ชื่อรูป'; err.hidden = false; input.focus(); return; }
        if (value === cur.name) return stop();
        save.disabled = true;
        try {
          const r = await api('PATCH', `/api/images/${cur.id}`, { name: value });
          cur = r.image;
          fill();
          stop();
          toast('เปลี่ยนชื่อแล้ว');
          loadImages();
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
          save.disabled = false;
        }
      });
      titleRow.replaceWith(form);
      input.focus();
      // Select the name part only, so typing keeps the extension.
      const dot = cur.name.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : cur.name.length);
    }
    if (renameBtn) renameBtn.addEventListener('click', startRename);
    title.addEventListener('dblclick', () => { if (renameBtn) startRename(); });
    deleteBtn.addEventListener('click', () => confirmDelete(cur, close));

    replaceInput.addEventListener('change', async () => {
      const file = replaceInput.files[0];
      replaceInput.value = '';
      if (!file) return;
      const maxMb = (state.settings && state.settings.max_upload_mb) || 10;
      if (file.type && !OK_TYPES.test(file.type)) return toast('ไม่ใช่ไฟล์รูปภาพที่รองรับ (JPG, PNG, GIF, WebP)', true);
      if (file.size > maxMb * MB) return toast(`ไฟล์ใหญ่เกิน ${maxMb} MB`, true);
      const old = Array.from(replaceBtn.childNodes);
      replaceBtn.disabled = true;
      try {
        const r = await xhrUpload('PUT', `/api/images/${cur.id}`, file, file.name, (p) => {
          replaceBtn.replaceChildren(`กำลังแทนที่… ${Math.round(p * 100)}%`);
        });
        cur = r.image;
        fill();
        toast('แทนที่รูปแล้ว — ลิงก์เดิมยังใช้ได้');
        loadImages();
      } catch (e) {
        toast(e.message, true);
      } finally {
        replaceBtn.disabled = false;
        replaceBtn.replaceChildren(...old);
      }
    });
  }

  function confirmDelete(img, afterDelete) {
    confirmDialog({
      title: `ลบรูป “${img.name}”?`,
      body: [
        h('p', null, 'ระบบที่ฝังลิงก์รูปนี้อยู่จะแสดงเป็นรูปเสียทันที และกู้คืนไม่ได้'),
        h('div', { class: 'code-box mono' }, img.url),
        h('p', { class: 'muted' }, 'ถ้าแค่อยากเปลี่ยนรูป ให้ใช้ “แทนที่รูป” แทน ลิงก์จะยังใช้ได้เหมือนเดิม'),
      ],
      confirmLabel: 'ลบถาวร',
      onConfirm: async () => {
        await api('DELETE', `/api/images/${img.id}`);
        if (afterDelete) afterDelete();
        toast('ลบรูปแล้ว');
        loadImages();
      },
    });
  }

  // ------------------------------------------------------------ users & settings (admin)
  function renderUsers() {
    els.usersTable = h('tbody');
    els.settingsBox = h('section', { class: 'panel', 'aria-labelledby': 'set-title' }, h('h2', { id: 'set-title' }, 'ตั้งค่าระบบ'), h('p', { class: 'muted' }, 'กำลังโหลด…'));

    // add-user form
    const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const uname = h('input', { class: 'input', id: 'a-user', placeholder: 'เช่น somchai', autocomplete: 'off', required: true });
    const dname = h('input', { class: 'input', id: 'a-name', placeholder: 'เช่น สมชาย ฝ่ายผลิต', autocomplete: 'off' });
    const pass = h('input', { class: 'input mono', id: 'a-pass', autocomplete: 'off', value: randomPassword(), required: true, minlength: 8 });
    const roleUser = h('input', { type: 'radio', name: 'role', value: 'user', checked: true });
    const roleAdmin = h('input', { type: 'radio', name: 'role', value: 'admin' });
    const addBtn = h('button', { type: 'submit', class: 'btn btn-primary btn-lg' }, 'เพิ่มผู้ใช้');
    const form = h('form', { class: 'panel users-side', 'aria-labelledby': 'add-title' },
      h('h2', { id: 'add-title' }, 'เพิ่มผู้ใช้ใหม่'),
      h('div', { class: 'field' }, h('label', { for: 'a-user' }, 'ชื่อผู้ใช้'), uname,
        h('span', { class: 'hint' }, 'a-z, 0-9, . _ - ยาว 3–32 ตัว')),
      h('div', { class: 'field' }, h('label', { for: 'a-name' }, 'ชื่อที่แสดง'), dname),
      h('div', { class: 'field' }, h('label', { for: 'a-pass' }, 'รหัสผ่านเริ่มต้น'),
        h('div', { class: 'copy-row' }, pass,
          h('button', { type: 'button', class: 'btn', onclick: () => { pass.value = randomPassword(); } }, 'สุ่มใหม่')),
        h('span', { class: 'hint' }, 'แจ้งรหัสนี้ให้ผู้ใช้ ระบบจะให้เปลี่ยนตอนล็อกอินครั้งแรก')),
      h('fieldset', { class: 'role-options' },
        h('legend', null, 'สิทธิ์'),
        h('label', { class: 'role-option' }, roleUser,
          h('span', null, h('strong', null, 'user'), h('small', null, 'อัปโหลด ดูทุกรูป ลบ/แทนที่ได้เฉพาะรูปของตัวเอง'))),
        h('label', { class: 'role-option' }, roleAdmin,
          h('span', null, h('strong', null, 'admin'), h('small', null, 'จัดการทุกรูป ผู้ใช้ และตั้งค่าระบบ')))),
      err, addBtn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      addBtn.disabled = true;
      try {
        await api('POST', '/api/users', {
          username: uname.value.trim(), display_name: dname.value.trim(), password: pass.value,
          role: roleAdmin.checked ? 'admin' : 'user',
        });
        toast(`เพิ่มผู้ใช้ ${uname.value.trim()} แล้ว`);
        uname.value = '';
        dname.value = '';
        pass.value = randomPassword();
        roleUser.checked = true;
        loadUsers();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      } finally {
        addBtn.disabled = false;
      }
    });

    $app.replaceChildren(
      topbar('users'),
      h('main', { class: 'container' },
        h('div', { class: 'users-layout' },
          h('div', { class: 'users-main' },
            h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'ผู้ใช้งาน'), h('p', null, 'เมนูนี้แสดงเฉพาะผู้ใช้สิทธิ์ admin'))),
            h('div', { class: 'table-wrap' },
              h('table', null,
                h('thead', null, h('tr', null,
                  h('th', { scope: 'col' }, 'ชื่อผู้ใช้'),
                  h('th', { scope: 'col' }, 'สิทธิ์'),
                  h('th', { scope: 'col' }, 'จำนวนรูป'),
                  h('th', { scope: 'col' }, 'เข้าใช้ล่าสุด'),
                  h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'จัดการ')))),
                els.usersTable)),
            els.settingsBox),
          form)));
    loadUsers();
    loadSettingsPanel();
  }

  async function loadUsers() {
    if (!els.usersTable) return;
    let d;
    try { d = await api('GET', '/api/users'); } catch (e) { if (e.status !== 401) toast(e.message, true); return; }
    if (!els.usersTable) return;
    els.usersTable.replaceChildren(...d.users.map((u) => {
      const isMe = u.id === state.me.id;
      const roleSel = h('select', { class: 'select', 'aria-label': `สิทธิ์ของ ${u.username}`, disabled: isMe },
        h('option', { value: 'user', selected: u.role === 'user' }, 'user'),
        h('option', { value: 'admin', selected: u.role === 'admin' }, 'admin'));
      roleSel.addEventListener('change', async () => {
        try {
          await api('PATCH', `/api/users/${u.id}`, { role: roleSel.value });
          toast(`เปลี่ยนสิทธิ์ ${u.username} เป็น ${roleSel.value} แล้ว`);
        } catch (e) {
          toast(e.message, true);
          roleSel.value = u.role;
        }
      });
      return h('tr', null,
        h('td', null,
          h('div', null, h('strong', null, u.username), isMe ? ' (คุณ)' : ''),
          u.display_name ? h('div', { class: 'sub' }, u.display_name) : null),
        h('td', null, roleSel),
        h('td', null, u.image_count.toLocaleString('th-TH')),
        h('td', null,
          u.last_login_at ? fmtDate(u.last_login_at) : h('span', { class: 'muted' }, 'ยังไม่เคยเข้าใช้'),
          u.must_change_pw ? h('div', null, h('span', { class: 'badge badge-warn' }, 'รอเปลี่ยนรหัสผ่าน')) : null),
        h('td', null, h('div', { class: 'row-actions' },
          h('button', { type: 'button', class: 'btn', onclick: () => resetPasswordDialog(u) }, 'รีเซ็ตรหัสผ่าน'),
          isMe ? null : h('button', { type: 'button', class: 'btn btn-danger-outline', onclick: () => deleteUserDialog(u) }, 'ลบ'))));
    }));
  }

  function resetPasswordDialog(u) {
    const id = nextId('rp');
    const input = h('input', { class: 'input mono', id, value: randomPassword(), autocomplete: 'off' });
    confirmDialog({
      title: `รีเซ็ตรหัสผ่าน ${u.username}`,
      danger: false,
      body: [
        h('div', { class: 'field' }, h('label', { for: id }, 'รหัสผ่านใหม่ (อย่างน้อย 8 ตัว)'), input,
          h('span', { class: 'hint' }, 'แจ้งรหัสนี้ให้ผู้ใช้ ระบบจะให้เปลี่ยนเมื่อเข้าสู่ระบบครั้งถัดไป และจะออกจากระบบทุกเครื่องทันที')),
      ],
      confirmLabel: 'ตั้งรหัสผ่าน',
      onConfirm: async () => {
        if (input.value.length < 8) throw new Error('รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
        await api('PATCH', `/api/users/${u.id}`, { password: input.value });
        toast(`ตั้งรหัสผ่านใหม่ให้ ${u.username} แล้ว`);
        loadUsers();
      },
    });
  }

  function deleteUserDialog(u) {
    confirmDialog({
      title: `ลบผู้ใช้ ${u.username}?`,
      body: [
        h('p', null, `รูปที่ผู้ใช้นี้อัปโหลด (${u.image_count} รูป) จะยังอยู่และลิงก์ยังใช้ได้ แต่จะไม่มีเจ้าของ — แก้ไขหรือลบได้เฉพาะ admin`),
      ],
      confirmLabel: 'ลบผู้ใช้',
      onConfirm: async () => {
        await api('DELETE', `/api/users/${u.id}`);
        toast(`ลบผู้ใช้ ${u.username} แล้ว`);
        loadUsers();
      },
    });
  }

  async function loadSettingsPanel() {
    await loadSettings();
    const s = state.settings;
    if (!els.settingsBox) return;
    const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const base = h('input', { class: 'input', id: 's-base', value: s.base_url || '', placeholder: s.effective_base_url || 'http://192.168.1.50:2681' });
    const max = h('input', { class: 'input', id: 's-max', type: 'number', min: 1, max: 500, value: String(s.max_upload_mb) });
    const save = h('button', { type: 'submit', class: 'btn btn-primary btn-lg' }, 'บันทึกการตั้งค่า');
    const disk = s.disk_total
      ? `ว่าง ${fmtBytes(s.disk_free)} จาก ${fmtBytes(s.disk_total)}`
      : '';
    const form = h('form', { class: 'panel', 'aria-labelledby': 'set-title' },
      h('h2', { id: 'set-title' }, 'ตั้งค่าระบบ'),
      h('div', { class: 'settings-grid' },
        h('div', { class: 'field' }, h('label', { for: 's-base' }, 'Base URL สำหรับลิงก์ที่คัดลอก'), base,
          h('span', { class: 'hint' }, 'เว้นว่าง = ใช้ที่อยู่ที่เปิดหน้าเว็บอยู่ (ตอนนี้: ', h('span', { class: 'mono' }, s.effective_base_url || ''),
            ') · ตั้งค่าเมื่อต้องการบังคับ IP หรือชื่อเครื่องที่เครื่องอื่นเข้าถึงได้')),
        h('div', { class: 'field' }, h('label', { for: 's-max' }, 'ขนาดไฟล์สูงสุด (MB)'), max)),
      err,
      h('div', { class: 'settings-foot' },
        h('span', null, `ที่เก็บข้อมูล: `, h('span', { class: 'mono' }, s.data_dir || ''),
          ` · ${s.image_count || 0} รูป (${fmtBytes(s.image_bytes || 0)})${disk ? ` · ${disk}` : ''}`),
        save));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      save.disabled = true;
      try {
        await api('PUT', '/api/settings', { base_url: base.value.trim(), max_upload_mb: Number(max.value) });
        toast('บันทึกการตั้งค่าแล้ว');
        loadSettingsPanel();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        save.disabled = false;
      }
    });
    els.settingsBox.replaceWith(form);
    els.settingsBox = form;
  }

  // ------------------------------------------------------------ boot
  (async function boot() {
    try { state.info = await api('GET', '/api/info'); } catch { state.info = null; }
    try {
      const r = await api('GET', '/api/me', undefined, { quiet401: true });
      state.me = r.user;
      if (!state.me.must_change_pw) await loadSettings();
    } catch {
      state.me = null;
    }
    route();
  })();
})();
