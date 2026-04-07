// client/client.js — Collaborative 3D Editor

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ── CRDT types (inlined for browser) ────────────────────────────────────────
function generateId(prefix = 'id') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2,9)}`;
}
class VectorClock {
  constructor(clock = {}) { this.clock = { ...clock }; }
  increment(id) { this.clock[id] = (this.clock[id] || 0) + 1; }
  merge(other) {
    const m = new VectorClock(this.clock);
    for (const [id, v] of Object.entries(other.clock)) m.clock[id] = Math.max(m.clock[id] || 0, v);
    return m;
  }
  toJSON() { return this.clock; }
  static fromJSON(j) { return new VectorClock(j || {}); }
}
class LWWRegister {
  constructor(value = null, timestamp = 0, clientId = null, vectorClock = new VectorClock()) {
    this.value = value; this.timestamp = timestamp;
    this.clientId = clientId; this.vectorClock = vectorClock;
  }
  set(value, timestamp, clientId, vectorClock) {
    this.value = value; this.timestamp = timestamp;
    this.clientId = clientId; this.vectorClock = vectorClock;
  }
  merge(other) {
    if (other.timestamp > this.timestamp ||
       (other.timestamp === this.timestamp && (other.clientId || '') > (this.clientId || ''))) {
      this.set(other.value, other.timestamp, other.clientId, other.vectorClock);
    }
    this.vectorClock = this.vectorClock.merge(other.vectorClock);
  }
  toJSON() { return { value: this.value, timestamp: this.timestamp, clientId: this.clientId, vectorClock: this.vectorClock.toJSON() }; }
  static fromJSON(j) { return new LWWRegister(j.value, j.timestamp, j.clientId, VectorClock.fromJSON(j.vectorClock)); }
}
class CRDTObject {
  constructor(id, type = 'mesh', geometry = 'box') {
    this.id = id; this.type = type; this.geometry = geometry;
    const now = Date.now(); const vc = new VectorClock();
    this.transform = {
      position: new LWWRegister({ x:0, y:0.5, z:0 }, now, null, vc),
      rotation: new LWWRegister({ x:0, y:0, z:0, w:1 }, now, null, vc),
      scale:    new LWWRegister({ x:1, y:1, z:1 }, now, null, vc),
    };
    this.metadata = {
      color: new LWWRegister('#' + Math.floor(Math.random()*16777215).toString(16).padStart(6,'0'), now, null, vc),
      name:  new LWWRegister('Object', now, null, vc),
    };
    this.createdBy = null; this.createdAt = now; this.tombstone = null;
  }
  updateProperty(property, value, timestamp, clientId, vc) {
    const keys = property.split('.'); let target = this;
    for (let i = 0; i < keys.length - 1; i++) target = target[keys[i]];
    const last = keys[keys.length - 1];
    if (target[last] instanceof LWWRegister) target[last].merge(new LWWRegister(value, timestamp, clientId, vc));
  }
  delete(ts, cid, vc) { this.tombstone = { ts, cid, vc }; }
  isDeleted() { return this.tombstone !== null; }
  toJSON() {
    return {
      id: this.id, type: this.type, geometry: this.geometry,
      tombstone: this.tombstone, createdBy: this.createdBy, createdAt: this.createdAt,
      transform: { position: this.transform.position.toJSON(), rotation: this.transform.rotation.toJSON(), scale: this.transform.scale.toJSON() },
      metadata:  { color: this.metadata.color.toJSON(), name: this.metadata.name.toJSON() },
    };
  }
  static fromJSON(j) {
    const o = new CRDTObject(j.id, j.type, j.geometry);
    o.transform.position = LWWRegister.fromJSON(j.transform.position);
    o.transform.rotation = LWWRegister.fromJSON(j.transform.rotation);
    o.transform.scale    = LWWRegister.fromJSON(j.transform.scale);
    o.metadata.color     = LWWRegister.fromJSON(j.metadata.color);
    o.metadata.name      = LWWRegister.fromJSON(j.metadata.name);
    o.createdBy = j.createdBy; o.createdAt = j.createdAt; o.tombstone = j.tombstone;
    return o;
  }
}
const OP  = { CREATE:'create', DELETE:'delete', TRANSFORM:'transform', METADATA:'metadata' };
const MSG = { OPERATION:'operation', SNAPSHOT:'snapshot', JOIN:'join', PRESENCE:'presence', PING:'ping', PONG:'pong' };

// ── Config ───────────────────────────────────────────────────────────────────
const API_URL = window.API_URL || `${location.protocol}//${location.hostname}:8080/api`;
const WS_URL  = window.WS_URL  || `ws://${location.hostname}:8080`;

function getToken() { return localStorage.getItem('token'); }
function getUser()  { return JSON.parse(localStorage.getItem('user') || 'null'); }
async function authPost(path, body) {
  const token = getToken();
  return fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

// ── Editor ───────────────────────────────────────────────────────────────────
class CollaborativeEditor {
  constructor() {
    this.clientId       = generateId('user');
    this.sceneId        = new URLSearchParams(location.search).get('scene') || 'default-scene';
    this.ws             = null;
    this.vectorClock    = new VectorClock();
    this.objects        = new Map();
    this.meshes         = new Map();
    this.selectedObject = null;
    this.selectedMesh   = null;
    this.users          = new Map();
    this.cursors        = new Map();
    this._undoStack     = [];
    this._redoStack     = [];
    this._dragging      = false;
    this._dragPlane     = new THREE.Plane(new THREE.Vector3(0,1,0), 0);
    this._dragOffset    = new THREE.Vector3();

    this._initThree();
    this._initWS();
    this._initControls();
    this._animate();

    // History panel
    import('./components/historyPanel.js').then(({ HistoryPanel }) => {
      this.historyPanel = new HistoryPanel(this.sceneId, getToken(), (snap) => {
        this.objects.forEach((_, id) => this._removeMesh(id));
        this.objects.clear();
        this._applySnapshot({ objects: snap.objects || {}, vectorClock: snap.vectorClock || {}, presence: [] });
      });
    }).catch(console.warn);

    const pending = sessionStorage.getItem('pendingImport');
    if (pending) { sessionStorage.removeItem('pendingImport'); setTimeout(() => this.importSnapshot(JSON.parse(pending)), 1500); }
  }

  // ── Three.js ─────────────────────────────────────────────────────────────
  _initThree() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a2e);
    this.scene.fog = new THREE.Fog(0x1a1a2e, 20, 60);

    this.camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);
    this.camera.position.set(6, 6, 6);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    document.getElementById('canvas-container').appendChild(this.renderer.domElement);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(8, 12, 8); dir.castShadow = true;
    this.scene.add(dir);
    this.scene.add(new THREE.HemisphereLight(0x4ECDC4, 0x1a1a2e, 0.3));

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      new THREE.MeshStandardMaterial({ color: 0x16213e, roughness: 0.9 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.name = 'ground';
    this.scene.add(ground);
    this.scene.add(new THREE.GridHelper(30, 30, 0x4ECDC4, 0x2a2a3e));

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 40;

    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    });
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────
  _initWS() {
    const token = getToken();
    const url = `${WS_URL}${token ? '?token=' + token : ''}`;
    this.ws = new WebSocket(url);
    this.ws.onopen    = () => {
      this._setStatus('Connected ✓', true);
      this._send({ type: MSG.JOIN, sceneId: this.sceneId, clientId: this.clientId, vectorClock: this.vectorClock.toJSON() });
    };
    this.ws.onmessage = (e) => { try { this._onMessage(JSON.parse(e.data)); } catch {} };
    this.ws.onclose   = () => { this._setStatus('Reconnecting…', false); setTimeout(() => this._initWS(), 3000); };
    this.ws.onerror   = () => {};
    setInterval(() => { if (this.ws?.readyState === 1) this._send({ type: MSG.PING, timestamp: Date.now() }); }, 25000);
  }

  // ── Input ─────────────────────────────────────────────────────────────────
  _initControls() {
    const el = this.renderer.domElement;

    el.addEventListener('click', (e) => {
      // Only select on click if we weren't dragging
      if (!this._didDrag) this._onClick(e);
      this._didDrag = false;
    });

    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      this._mouseDownPos = { x: e.clientX, y: e.clientY };
      this._didDrag = false;

      if (!this.selectedMesh) return;
      // Update raycaster at mousedown position
      this._updateMouse(e);
      this.raycaster.setFromCamera(this.mouse, this.camera);
      const hits = this.raycaster.intersectObject(this.selectedMesh);
      if (hits.length) {
        this._dragging = true;
        this.controls.enabled = false;
        this._dragOffset.copy(hits[0].point).sub(this.selectedMesh.position);
      }
    });

    el.addEventListener('mousemove', (e) => {
      // Detect drag vs click
      if (this._mouseDownPos) {
        const dx = e.clientX - this._mouseDownPos.x, dy = e.clientY - this._mouseDownPos.y;
        if (Math.hypot(dx, dy) > 4) this._didDrag = true;
      }

      if (this._dragging && this.selectedObject) {
        this._updateMouse(e);
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const pt = new THREE.Vector3();
        if (this.raycaster.ray.intersectPlane(this._dragPlane, pt)) {
          this.moveObject(this.selectedObject, pt.sub(this._dragOffset));
        }
      }

      // Broadcast cursor presence
      if (this.ws?.readyState === 1) {
        this._send({ type: MSG.PRESENCE, sceneId: this.sceneId, clientId: this.clientId,
          cursor: { x: e.clientX, y: e.clientY }, selectedObjects: this.selectedObject ? [this.selectedObject] : [] });
      }
    });

    el.addEventListener('mouseup', () => {
      this._dragging = false;
      this.controls.enabled = true;
      this._mouseDownPos = null;
    });

    addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.shiftKey ? this.redo() : this.undo(); e.preventDefault(); return; }
      if (!this.selectedObject) return;
      switch (e.key) {
        case 'q': case 'Q': this.rotateObject(this.selectedObject, -0.15); break;
        case 'e': case 'E': this.rotateObject(this.selectedObject,  0.15); break;
        case 'w': case 'W': this.scaleObject(this.selectedObject, 1.1);    break;
        case 's': case 'S': this.scaleObject(this.selectedObject, 0.9);    break;
        case 'Delete': case 'Backspace': this.deleteSelected(); e.preventDefault(); break;
        case 'Escape': this._deselect(); break;
      }
    });
  }

  // ── Fixed: correct NDC Y sign (-2, not +2) ────────────────────────────────
  _updateMouse(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1; // ← FIXED sign
  }

  _onClick(e) {
    this._updateMouse(e);
    this.raycaster.setFromCamera(this.mouse, this.camera);
    // Only intersect actual object meshes, not ground
    const meshList = [...this.meshes.values()];
    const hits = this.raycaster.intersectObjects(meshList);
    if (hits.length) {
      this._select(hits[0].object.userData.objectId);
    } else {
      this._deselect();
    }
  }

  // ── Messages ──────────────────────────────────────────────────────────────
  _onMessage(msg) {
    switch (msg.type) {
      case MSG.SNAPSHOT:  this._applySnapshot(msg); break;
      case MSG.OPERATION: this._applyOp(msg);       break;
      case MSG.PRESENCE:  this._applyPresence(msg); break;
      case 'user_left':
        this.users.delete(msg.clientId);
        this._removeCursor(msg.clientId);
        this._renderUsers();
        break;
    }
  }

  _applySnapshot(snap) {
    if (snap.vectorClock) this.vectorClock = VectorClock.fromJSON(snap.vectorClock);
    for (const [id, data] of Object.entries(snap.objects || {})) {
      if (!data.tombstone) {
        const obj = CRDTObject.fromJSON(data);
        this.objects.set(id, obj);
        this._createMesh(obj);
      }
    }
    (snap.presence || []).forEach(p => {
      if (p.clientId !== this.clientId) this.users.set(p.clientId, { color: p.color || '#FF6B6B' });
    });
    this._renderUsers();
  }

  _applyOp(op) {
    this.vectorClock = this.vectorClock.merge(VectorClock.fromJSON(op.vectorClock || {}));
    switch (op.op) {
      case OP.CREATE:    this._opCreate(op);    break;
      case OP.DELETE:    this._opDelete(op);    break;
      case OP.TRANSFORM: this._opTransform(op); break;
      case OP.METADATA:  this._opMetadata(op);  break;
    }
  }

  _applyPresence(p) {
    if (p.clientId === this.clientId) return;
    this.users.set(p.clientId, { ...this.users.get(p.clientId), color: this.users.get(p.clientId)?.color || '#FF6B6B', cursor: p.cursor });
    if (p.cursor) this._updateCursor(p.clientId, p.cursor);
    this._renderUsers();
  }

  _opCreate(op) {
    if (this.objects.has(op.objectId)) return; // already exists
    const obj = new CRDTObject(op.objectId, op.objectData.type, op.objectData.geometry);
    const vc  = VectorClock.fromJSON(op.vectorClock || {});
    const { position, rotation, scale } = op.objectData.transform || {};
    if (position) obj.transform.position.set(position.value, op.timestamp, op.clientId, vc);
    if (rotation) obj.transform.rotation.set(rotation.value, op.timestamp, op.clientId, vc);
    if (scale)    obj.transform.scale.set(scale.value,       op.timestamp, op.clientId, vc);
    if (op.objectData.metadata) {
      for (const [k, d] of Object.entries(op.objectData.metadata)) {
        if (obj.metadata[k]) obj.metadata[k].set(d.value, op.timestamp, op.clientId, vc);
      }
    }
    this.objects.set(op.objectId, obj);
    this._createMesh(obj);
  }

  _opDelete(op) {
    const obj = this.objects.get(op.objectId);
    if (obj) { obj.delete(op.timestamp, op.clientId, VectorClock.fromJSON(op.vectorClock || {})); this._removeMesh(op.objectId); if (this.selectedObject === op.objectId) this._deselect(); }
  }

  _opTransform(op) {
    const obj = this.objects.get(op.objectId);
    if (obj && !obj.isDeleted()) { obj.updateProperty(`transform.${op.property}`, op.value, op.timestamp, op.clientId, VectorClock.fromJSON(op.vectorClock || {})); this._updateMesh(obj); }
  }

  _opMetadata(op) {
    const obj = this.objects.get(op.objectId);
    if (obj && !obj.isDeleted()) { obj.updateProperty(`metadata.${op.property}`, op.value, op.timestamp, op.clientId, VectorClock.fromJSON(op.vectorClock || {})); this._updateMesh(obj); }
  }

  // ── Meshes ────────────────────────────────────────────────────────────────
  _createMesh(obj) {
    if (this.meshes.has(obj.id)) return;
    const geo = obj.geometry === 'sphere'   ? new THREE.SphereGeometry(0.5, 24, 24)
              : obj.geometry === 'cylinder' ? new THREE.CylinderGeometry(0.5, 0.5, 1, 24)
              : new THREE.BoxGeometry(1, 1, 1);
    const mat  = new THREE.MeshStandardMaterial({ color: obj.metadata.color.value, roughness: 0.5, metalness: 0.3 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData.objectId = obj.id;
    this._applyTransformToMesh(mesh, obj);
    this.scene.add(mesh);
    this.meshes.set(obj.id, mesh);
  }

  _updateMesh(obj) {
    const mesh = this.meshes.get(obj.id);
    if (!mesh) return;
    this._applyTransformToMesh(mesh, obj);
    mesh.material.color.set(obj.metadata.color.value);
    if (this.selectedObject === obj.id) this._renderSelectedInfo();
  }

  _applyTransformToMesh(mesh, obj) {
    const p = obj.transform.position.value;
    const r = obj.transform.rotation.value;
    const s = obj.transform.scale.value;
    mesh.position.set(p.x, p.y, p.z);
    mesh.quaternion.set(r.x, r.y, r.z, r.w);
    mesh.scale.set(s.x, s.y, s.z);
  }

  _removeMesh(id) {
    const mesh = this.meshes.get(id);
    if (!mesh) return;
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
    this.meshes.delete(id);
  }

  // ── Operations ────────────────────────────────────────────────────────────
  _sendOp(op) {
    this.vectorClock.increment(this.clientId);
    op.vectorClock = this.vectorClock.toJSON();
    op.timestamp   = Date.now();
    op.clientId    = this.clientId;
    op.sceneId     = this.sceneId;
    op.type        = MSG.OPERATION;
    this._undoStack.push(JSON.parse(JSON.stringify(op)));
    if (this._undoStack.length > 50) this._undoStack.shift();
    this._redoStack = [];
    this._applyOp(op);
    this._send(op);
  }

  addObject(geometry) {
    const color = '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
    this._sendOp({
      op: OP.CREATE,
      objectId: generateId('obj'),
      objectData: {
        type: 'mesh', geometry,
        transform: {
          position: { value: { x: (Math.random() - 0.5) * 6, y: 0.5, z: (Math.random() - 0.5) * 6 } },
          rotation: { value: { x: 0, y: 0, z: 0, w: 1 } },
          scale:    { value: { x: 1, y: 1, z: 1 } },
        },
        metadata: {
          color: { value: color },
          name:  { value: geometry + '-' + Date.now() },
        },
      },
    });
  }

  addCube()     { this.addObject('box');      }
  addSphere()   { this.addObject('sphere');   }
  addCylinder() { this.addObject('cylinder'); }

  moveObject(id, pos) {
    this._sendOp({ op: OP.TRANSFORM, objectId: id, property: 'position', value: { x: pos.x, y: Math.max(0, pos.y), z: pos.z } });
  }

  rotateObject(id, dy) {
    const obj = this.objects.get(id); if (!obj) return;
    const q = new THREE.Quaternion(obj.transform.rotation.value.x, obj.transform.rotation.value.y, obj.transform.rotation.value.z, obj.transform.rotation.value.w);
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), dy));
    this._sendOp({ op: OP.TRANSFORM, objectId: id, property: 'rotation', value: { x: q.x, y: q.y, z: q.z, w: q.w } });
  }

  scaleObject(id, f) {
    const obj = this.objects.get(id); if (!obj) return;
    const s = obj.transform.scale.value;
    const ns = { x: Math.max(0.1, s.x * f), y: Math.max(0.1, s.y * f), z: Math.max(0.1, s.z * f) };
    this._sendOp({ op: OP.TRANSFORM, objectId: id, property: 'scale', value: ns });
  }

  deleteSelected() {
    if (!this.selectedObject) return;
    this._sendOp({ op: OP.DELETE, objectId: this.selectedObject });
    this._deselect();
  }

  undo() {
    const op = this._undoStack.pop(); if (!op) return;
    this._redoStack.push(op);
    // For simplicity, send delete for create ops and vice versa
    if (op.op === OP.CREATE) {
      this._sendOp({ op: OP.DELETE, objectId: op.objectId });
    }
  }

  redo() {
    const op = this._redoStack.pop(); if (!op) return;
    this._undoStack.push(op);
    this._sendOp(op);
  }

  importSnapshot(snapshot) {
    if (!snapshot?.objects) return;
    for (const data of Object.values(snapshot.objects)) {
      const obj = CRDTObject.fromJSON(data);
      const pos = obj.transform.position.value;
      this._sendOp({
        op: OP.CREATE, objectId: generateId('obj'),
        objectData: {
          type: obj.type, geometry: obj.geometry,
          transform: {
            position: { value: { x: pos.x + (Math.random() * 2 - 1), y: pos.y, z: pos.z + (Math.random() * 2 - 1) } },
            rotation: { value: obj.transform.rotation.value },
            scale:    { value: obj.transform.scale.value },
          },
          metadata: {
            color: { value: obj.metadata.color.value },
            name:  { value: (obj.metadata.name.value || obj.geometry) + ' (imported)' },
          },
        },
      });
    }
  }

  async _promptModal(titleText, defaultText = '', optional = false) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:10000;backdrop-filter:blur(3px);';
      const box = document.createElement('div');
      box.style.cssText = 'background:#1a1f2e;padding:24px;border-radius:12px;width:320px;border:1px solid #2d3748;box-shadow:0 20px 40px rgba(0,0,0,0.4);font-family:sans-serif;color:#e2e8f0;';
      
      const header = document.createElement('h3');
      header.textContent = titleText;
      header.style.cssText = 'margin:0 0 16px 0;font-size:16px;font-weight:700;color:#fff;';
      
      const input = document.createElement('input');
      input.type = 'text'; input.value = defaultText;
      input.placeholder = optional ? 'Optional' : 'Required';
      input.style.cssText = 'width:100%;padding:10px 12px;background:#0f1117;border:1px solid #2d3748;border-radius:6px;color:#fff;outline:none;font-size:14px;box-sizing:border-box;margin-bottom:20px;';
      input.onfocus = () => input.style.borderColor = '#4ECDC4';
      input.onblur = () => input.style.borderColor = '#2d3748';
      
      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;';
      
      const btnCancel = document.createElement('button');
      btnCancel.textContent = 'Cancel';
      btnCancel.style.cssText = 'padding:8px 16px;background:transparent;border:none;color:#a0aec0;cursor:pointer;font-weight:600;font-size:14px;border-radius:6px;transition:0.2s;';
      btnCancel.onmouseover = () => btnCancel.style.color = '#fff';
      btnCancel.onmouseout = () => btnCancel.style.color = '#a0aec0';
      
      const btnOk = document.createElement('button');
      btnOk.textContent = 'Continue';
      btnOk.style.cssText = 'padding:8px 16px;background:linear-gradient(135deg, #4ECDC4, #45B7D1);border:none;color:#0f1117;cursor:pointer;font-weight:700;font-size:14px;border-radius:6px;transition:opacity 0.2s;';
      btnOk.onmouseover = () => btnOk.style.opacity = '0.85';
      btnOk.onmouseout = () => btnOk.style.opacity = '1';
      
      const cleanup = (val) => { document.body.removeChild(overlay); resolve(val); };
      btnCancel.onclick = () => cleanup(null);
      btnOk.onclick = () => cleanup(input.value);
      input.onkeydown = e => { if (e.key === 'Enter') btnOk.click(); if (e.key === 'Escape') btnCancel.click(); };
      
      btnRow.appendChild(btnCancel); btnRow.appendChild(btnOk);
      box.appendChild(header); box.appendChild(input); box.appendChild(btnRow);
      overlay.appendChild(box); document.body.appendChild(overlay);
      input.select();
    });
  }

  async publishScene() {
    const token = getToken();
    if (!token) { alert('Sign in to publish.'); return; }
    
    const title = await this._promptModal('Enter model title:', 'My Scene');
    if (!title) return;
    
    const description = await this._promptModal('Enter description:', '', true);
    if (description === null) return;
    
    try {
      const ensureRes  = await authPost('/scenes/ensure', { sceneId: this.sceneId, name: title, snapshot: this._buildSnapshot() });
      const ensureData = await ensureRes.json();
      if (!ensureRes.ok) throw new Error(ensureData.error || 'Could not save scene');
      
      const pubRes  = await authPost('/models', { sceneId: this.sceneId, title, description, tags: [] });
      const pubData = await pubRes.json();
      if (!pubRes.ok) throw new Error(pubData.error);
      alert(`✅ Published "${pubData.model.title}" to the library!`);
    } catch (err) { alert(`Publish failed: ${err.message}`); }
  }

  _buildSnapshot() {
    const objects = {};
    this.objects.forEach((obj, id) => { if (!obj.isDeleted()) objects[id] = obj.toJSON(); });
    return { objects, vectorClock: this.vectorClock.toJSON() };
  }

  async exportScene(format = 'json') {
    const token = getToken();
    if (!token) { alert('Sign in to export.'); return; }
    try {
      const res  = await authPost(`/scenes/${this.sceneId}/export`, { format });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      window.open(API_URL.replace('/api', '') + data.url, '_blank');
    } catch (err) { alert(`Export failed: ${err.message}`); }
  }

  // ── Selection UI ──────────────────────────────────────────────────────────
  _select(id) {
    this._deselect();
    this.selectedObject = id;
    this.selectedMesh   = this.meshes.get(id);
    if (this.selectedMesh) {
      this.selectedMesh.material = this.selectedMesh.material.clone();
      this.selectedMesh.material.emissive.setHex(0x4ECDC4);
      this.selectedMesh.material.emissiveIntensity = 0.35;
    }
    this._renderSelectedInfo();
  }

  _deselect() {
    if (this.selectedMesh) {
      this.selectedMesh.material.emissive.setHex(0x000000);
      this.selectedMesh.material.emissiveIntensity = 0;
    }
    this.selectedObject = null;
    this.selectedMesh   = null;
    const el = document.getElementById('selected-info');
    if (el) el.style.display = 'none';
  }

  _renderSelectedInfo() {
    const el = document.getElementById('selected-info');
    const d  = document.getElementById('selected-details');
    if (!this.selectedObject || !el || !d) return;
    const obj = this.objects.get(this.selectedObject); if (!obj) return;
    el.style.display = 'block';
    const p = obj.transform.position.value;
    const s = obj.transform.scale.value;
    d.innerHTML = `
      <div class="info-row"><span class="info-label">Type</span><span>${obj.geometry}</span></div>
      <div class="info-row"><span class="info-label">Pos</span><span>${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}</span></div>
      <div class="info-row"><span class="info-label">Scale</span><span>${s.x.toFixed(2)}</span></div>
      <div class="info-row"><span class="info-label">Color</span><span style="background:${obj.metadata.color.value};padding:1px 8px;border-radius:3px;font-size:10px">${obj.metadata.color.value}</span></div>
    `;
  }

  // ── Cursors ───────────────────────────────────────────────────────────────
  _updateCursor(clientId, cursor) {
    let el = this.cursors.get(clientId);
    if (!el) {
      el = document.createElement('div');
      el.className = 'cursor';
      const lbl = document.createElement('div');
      lbl.className = 'cursor-label';
      lbl.textContent = clientId.slice(0, 8);
      el.appendChild(lbl);
      document.body.appendChild(el);
      this.cursors.set(clientId, el);
    }
    const u = this.users.get(clientId);
    if (u) el.style.backgroundColor = u.color;
    el.style.left = cursor.x + 'px';
    el.style.top  = cursor.y + 'px';
  }

  _removeCursor(id) { this.cursors.get(id)?.remove(); this.cursors.delete(id); }

  _renderUsers() {
    const list = document.getElementById('user-list'); if (!list) return;
    const me = getUser();
    list.innerHTML = `<div class="user-item"><div class="user-dot" style="background:#4ECDC4"></div><span>${me?.username || 'You'}</span></div>`;
    this.users.forEach((u, id) => {
      const item = document.createElement('div');
      item.className = 'user-item';
      item.innerHTML = `<div class="user-dot" style="background:${u.color}"></div><span>${id.slice(0, 10)}</span>`;
      list.appendChild(item);
    });
  }

  _setStatus(msg, ok) {
    const el = document.getElementById('status'); if (!el) return;
    el.textContent = msg;
    el.className   = ok ? '' : 'disconnected';
  }

  _send(msg) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg)); }

  _animate() {
    requestAnimationFrame(() => this._animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

const app = new CollaborativeEditor();
window.app = app;