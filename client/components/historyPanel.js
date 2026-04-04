// client/components/historyPanel.js
// Slide-in version history panel for the editor.

export class HistoryPanel {
  constructor(sceneId, token, onRestore) {
    this.sceneId   = sceneId;
    this.token     = token;
    this.onRestore = onRestore;
    this.visible   = false;
    this.versions  = [];
    this.branch    = 'main';
    this.api       = `${location.protocol}//${location.hostname}:8080/api`;

    this._buildDOM();
  }

  // ── DOM ────────────────────────────────────────────────────────────────────

  _buildDOM() {
    // Inject styles
    const style = document.createElement('style');
    style.textContent = `
      #hp-panel {
        position: fixed; right: 0; top: 0; bottom: 0; width: 290px;
        background: #1a1f2e; border-left: 1px solid #2d3748;
        display: flex; flex-direction: column; z-index: 300;
        transform: translateX(100%);
        transition: transform 0.25s ease;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
      #hp-panel.open { transform: translateX(0); }

      .hp-head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 16px; border-bottom: 1px solid #2d3748; flex-shrink: 0;
      }
      .hp-head h2 { font-size: 14px; font-weight: 700; color: #fff; }
      .hp-close {
        background: none; border: none; color: #718096;
        cursor: pointer; font-size: 18px; line-height: 1; padding: 2px;
      }
      .hp-close:hover { color: #fff; transform: none; }

      .hp-toolbar {
        padding: 10px 14px; border-bottom: 1px solid #2d3748;
        display: flex; gap: 8px; flex-shrink: 0;
      }
      .hp-save-btn {
        flex: 1; padding: 7px; font-size: 12px; font-weight: 600;
        background: rgba(78,205,196,0.12); color: #4ECDC4;
        border: 1px solid rgba(78,205,196,0.3); border-radius: 6px; cursor: pointer;
      }
      .hp-save-btn:hover { background: rgba(78,205,196,0.22); transform: none; }

      .hp-branch-select {
        flex: 1; padding: 6px 10px; font-size: 12px;
        background: #0f1117; border: 1px solid #2d3748; border-radius: 6px;
        color: #a0aec0; outline: none; cursor: pointer;
      }

      .hp-list { flex: 1; overflow-y: auto; }
      .hp-list::-webkit-scrollbar { width: 3px; }
      .hp-list::-webkit-scrollbar-thumb { background: #2d3748; }

      .hp-empty { padding: 40px 16px; text-align: center; color: #4a5568; font-size: 13px; }

      .hp-item {
        padding: 11px 14px; cursor: default;
        border-left: 3px solid transparent;
        transition: background 0.1s;
      }
      .hp-item:hover { background: rgba(255,255,255,0.03); border-left-color: #2d3748; }

      .hp-item-top {
        display: flex; align-items: center;
        justify-content: space-between; margin-bottom: 4px;
      }
      .hp-item-label { font-size: 13px; font-weight: 600; color: #e2e8f0; max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .hp-item-seq   { font-size: 11px; color: #4a5568; font-family: monospace; }
      .hp-item-meta  { font-size: 11px; color: #718096; margin-bottom: 7px; }

      .hp-actions { display: flex; gap: 6px; }
      .hp-btn-restore {
        padding: 4px 10px; font-size: 11px; font-weight: 600; border-radius: 5px;
        background: rgba(78,205,196,0.12); color: #4ECDC4; border: none; cursor: pointer;
      }
      .hp-btn-restore:hover { background: rgba(78,205,196,0.25); transform: none; }
      .hp-btn-branch {
        padding: 4px 10px; font-size: 11px; font-weight: 600; border-radius: 5px;
        background: rgba(255,255,255,0.06); color: #a0aec0; border: none; cursor: pointer;
      }
      .hp-btn-branch:hover { background: rgba(255,255,255,0.12); transform: none; }

      .hp-loading { padding: 30px; text-align: center; color: #718096; font-size: 13px; }
    `;
    document.head.appendChild(style);

    // Panel element
    this.el = document.createElement('div');
    this.el.id = 'hp-panel';
    this.el.innerHTML = `
      <div class="hp-head">
        <h2>⏱ Version History</h2>
        <button class="hp-close" id="hp-close-btn">✕</button>
      </div>
      <div class="hp-toolbar">
        <button class="hp-save-btn" id="hp-save-btn">💾 Save Now</button>
        <select class="hp-branch-select" id="hp-branch-select">
          <option value="main">main</option>
        </select>
      </div>
      <div class="hp-list" id="hp-list">
        <div class="hp-empty">No versions yet.</div>
      </div>
    `;
    document.body.appendChild(this.el);

    this.el.querySelector('#hp-close-btn').addEventListener('click', () => this.hide());
    this.el.querySelector('#hp-save-btn').addEventListener('click',  () => this.saveNow());
    this.el.querySelector('#hp-branch-select').addEventListener('change', (e) => {
      this.branch = e.target.value;
      this.load();
    });
  }

  // ── Public ─────────────────────────────────────────────────────────────────

  show()   { this.visible = true;  this.el.classList.add('open');    this.load(); }
  hide()   { this.visible = false; this.el.classList.remove('open'); }
  toggle() { this.visible ? this.hide() : this.show(); }
  setToken(t) { this.token = t; }

  // ── Load versions ──────────────────────────────────────────────────────────

  async load() {
    const list = this.el.querySelector('#hp-list');
    list.innerHTML = '<div class="hp-loading">Loading…</div>';

    try {
      const res  = await fetch(`${this.api}/scenes/${this.sceneId}/versions?branch=${this.branch}&limit=50`, {
        headers: { Authorization: `Bearer ${this.token}` }
      });
      const data = await res.json();
      this.versions = data.versions || [];
      this._render();
    } catch (err) {
      list.innerHTML = `<div class="hp-empty">Error: ${err.message}</div>`;
    }
  }

  _render() {
    const list = this.el.querySelector('#hp-list');

    if (!this.versions.length) {
      list.innerHTML = '<div class="hp-empty">No versions on this branch.</div>';
      return;
    }

    list.innerHTML = '';
    this.versions.forEach(v => {
      const label  = v.label || `Op #${v.seqNumAt}`;
      const author = v.createdByUser?.username || '?';
      const time   = this._relTime(v.createdAt);

      const item = document.createElement('div');
      item.className = 'hp-item';
      item.innerHTML = `
        <div class="hp-item-top">
          <span class="hp-item-label" title="${label}">${label}</span>
          <span class="hp-item-seq">#${v.seqNumAt}</span>
        </div>
        <div class="hp-item-meta">@${author} · ${time} · ${v.branchName}</div>
        <div class="hp-actions">
          <button class="hp-btn-restore">↩ Restore</button>
          <button class="hp-btn-branch">⎇ Branch</button>
        </div>
      `;

      item.querySelector('.hp-btn-restore').addEventListener('click', () => this._restore(v));
      item.querySelector('.hp-btn-branch').addEventListener('click',  () => this._branch(v));
      list.appendChild(item);
    });
  }

  // ── Save version now ───────────────────────────────────────────────────────

  async saveNow() {
    const label = prompt('Label (optional):', `Save ${new Date().toLocaleTimeString()}`);
    if (label === null) return;
    try {
      const res = await fetch(`${this.api}/scenes/${this.sceneId}/versions/save`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body:    JSON.stringify({ label: label || undefined, branchName: this.branch })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      this.load();
    } catch (err) {
      alert(`Save failed: ${err.message}`);
    }
  }

  // ── Restore ────────────────────────────────────────────────────────────────

  async _restore(version) {
    if (!confirm(`Restore to "${version.label || `Op #${version.seqNumAt}`}"?\n\nCurrent state will be auto-saved first.`)) return;
    try {
      const res  = await fetch(`${this.api}/scenes/${this.sceneId}/versions/${version.id}/restore`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${this.token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (this.onRestore && data.version?.snapshotJson) {
        this.onRestore(data.version.snapshotJson);
      }
      this.load();
    } catch (err) {
      alert(`Restore failed: ${err.message}`);
    }
  }

  // ── Create branch ──────────────────────────────────────────────────────────

  async _branch(version) {
    const name = prompt('New branch name:');
    if (!name?.trim()) return;
    try {
      const res = await fetch(`${this.api}/scenes/${this.sceneId}/versions/${version.id}/branch`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body:    JSON.stringify({ branchName: name.trim() })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      const sel = this.el.querySelector('#hp-branch-select');
      const opt = document.createElement('option');
      opt.value = name.trim();
      opt.textContent = name.trim();
      sel.appendChild(opt);
      sel.value  = name.trim();
      this.branch = name.trim();
      this.load();
    } catch (err) {
      alert(`Branch failed: ${err.message}`);
    }
  }

  _relTime(iso) {
    const diff  = Date.now() - new Date(iso).getTime();
    const mins  = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days  = Math.floor(diff / 86400000);
    if (mins < 1)   return 'just now';
    if (mins < 60)  return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  }
}