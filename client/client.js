// client/client.js — 3D Editor (frontend, runs in browser)
// Uses window.API_URL and window.WS_URL set in index.html

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ── Inline CRDT types (no server import needed in browser) ────────────────
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
  compare(other) {
    let gt = false, lt = false;
    const all = new Set([...Object.keys(this.clock), ...Object.keys(other.clock)]);
    for (const id of all) {
      const a = this.clock[id] || 0, b = other.clock[id] || 0;
      if (a > b) gt = true; if (a < b) lt = true;
    }
    if (gt && lt) return null; if (gt) return 1; if (lt) return -1; return 0;
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
    const cmp = this.vectorClock.compare(other.vectorClock);
    if (cmp === 1) return;
    if (cmp === -1) { this.set(other.value, other.timestamp, other.clientId, other.vectorClock); return; }
    if (other.timestamp > this.timestamp ||
       (other.timestamp === this.timestamp && other.clientId > this.clientId)) {
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
      position: new LWWRegister({ x:0, y:0, z:0 },       now, null, vc),
      rotation: new LWWRegister({ x:0, y:0, z:0, w:1 },  now, null, vc),
      scale:    new LWWRegister({ x:1, y:1, z:1 },        now, null, vc),
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
  delete(timestamp, clientId, vc) { this.tombstone = { timestamp, clientId, vc }; }
  isDeleted() { return this.tombstone !== null; }
  toJSON() {
    return {
      id: this.id, type: this.type, geometry: this.geometry, tombstone: this.tombstone,
      createdBy: this.createdBy, createdAt: this.createdAt,
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

const OP   = { CREATE:'create', DELETE:'delete', TRANSFORM:'transform', METADATA:'metadata', MERGE:'merge' };
const MSG  = { OPERATION:'operation', SNAPSHOT:'snapshot', JOIN:'join', PRESENCE:'presence', PING:'ping', PONG:'pong' };

// ── API / WS base URLs (set in index.html, fallback for dev) ─────────────
const API_URL = window.API_URL || 'http://localhost:8080/api';
const WS_URL  = window.WS_URL  || 'ws://localhost:8080';

// ── Auth helpers ─────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────
// EDITOR
// ─────────────────────────────────────────────────────────────────────────
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

    this._initThree();
    this._initWS();
    this._initControls();
    this._animate();

    // History panel (lazy import)
    import('./components/historyPanel.js').then(({ HistoryPanel }) => {
      this.historyPanel = new HistoryPanel(this.sceneId, getToken, (snapshot) => {
        this.objects.forEach((_, id) => this._removeMesh(id));
        this.objects.clear();
        this._applySnapshot({ objects: snapshot.objects || {}, vectorClock: snapshot.vectorClock || {}, presence: [] });
      });
    }).catch(() => {});

    // Pending import from library page
    const pending = sessionStorage.getItem('pendingImport');
    if (pending) { sessionStorage.removeItem('pendingImport'); setTimeout(() => this.importSnapshot(JSON.parse(pending)), 1500); }
  }

  // ── Three.js setup ──────────────────────────────────────────────────────
  _initThree() {
    this.scene  = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a2e);
    this.scene.fog        = new THREE.Fog(0x1a1a2e, 10, 50);

    this.camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 1000);
    this.camera.position.set(5, 5, 5);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    document.getElementById('canvas-container').appendChild(this.renderer.domElement);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(5, 10, 5); dir.castShadow = true;
    this.scene.add(dir);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(20,20), new THREE.MeshStandardMaterial({ color:0x16213e }));
    ground.rotation.x = -Math.PI/2; ground.receiveShadow = true;
    this.scene.add(ground);
    this.scene.add(new THREE.GridHelper(20, 20, 0x4ECDC4, 0x2a2a3e));

    this.controls   = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.raycaster  = new THREE.Raycaster();
    this.mouse      = new THREE.Vector2();

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    });
  }

  // ── WebSocket ───────────────────────────────────────────────────────────
  _initWS() {
    const token = getToken();
    const url   = `${WS_URL}${token ? '?token=' + token : ''}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this._setStatus('Connected', true);
      this._send({ type: MSG.JOIN, sceneId: this.sceneId, clientId: this.clientId, vectorClock: this.vectorClock.toJSON() });
    };
    this.ws.onmessage = (e) => this._onMessage(JSON.parse(e.data));
    this.ws.onclose   = () => { this._setStatus('Disconnected', false); setTimeout(() => this._initWS(), 3000); };
    this.ws.onerror   = (e) => console.error('WS error:', e);

    setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN) this._send({ type: MSG.PING, timestamp: Date.now() });
    }, 30000);
  }

  // ── Input controls ──────────────────────────────────────────────────────
  _initControls() {
    const el = this.renderer.domElement;
    el.addEventListener('click',     (e) => this._onClick(e));
    el.addEventListener('mousemove', (e) => this._onMouseMove(e));
    addEventListener('keydown',      (e) => this._onKeyDown(e));

    let dragging = false;
    const plane  = new THREE.Plane(new THREE.Vector3(0,1,0), 0);
    const offset = new THREE.Vector3();

    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !this.selectedMesh || e.shiftKey) return;
      dragging = true; this.controls.enabled = false;
      const hits = this.raycaster.intersectObject(this.selectedMesh);
      if (hits[0]) offset.copy(hits[0].point).sub(this.selectedMesh.position);
    });
    el.addEventListener('mousemove', (e) => {
      if (!dragging || !this.selectedObject) return;
      this.mouse.x = (e.clientX / innerWidth) * 2 - 1;
      this.mouse.y = (e.clientY / innerHeight) * 2 + 1;
      this.raycaster.setFromCamera(this.mouse, this.camera);
      const pt = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(plane, pt)) this.moveObject(this.selectedObject, pt.sub(offset));
    });
    el.addEventListener('mouseup', () => { dragging = false; this.controls.enabled = true; });
  }

  _onClick(e) {
    this.mouse.x = (e.clientX / innerWidth) * 2 - 1;
    this.mouse.y = (e.clientY / innerHeight) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hits = this.raycaster.intersectObjects([...this.meshes.values()]);
    hits.length ? this._select(hits[0].object.userData.objectId) : this._deselect();
  }

  _onMouseMove(e) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this._send({ type: MSG.PRESENCE, sceneId: this.sceneId, clientId: this.clientId,
        cursor: { x: e.clientX, y: e.clientY },
        selectedObjects: this.selectedObject ? [this.selectedObject] : [] });
    }
  }

  _onKeyDown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.shiftKey ? this.redo() : this.undo(); e.preventDefault(); return; }
    if (!this.selectedObject) return;
    switch (e.key) {
      case 'q': this.rotateObject(this.selectedObject, -0.1); break;
      case 'e': this.rotateObject(this.selectedObject,  0.1); break;
      case 'w': this.scaleObject(this.selectedObject, 1.1);   break;
      case 's': this.scaleObject(this.selectedObject, 0.9);   break;
      case 'Delete': case 'Backspace': this.deleteSelected(); e.preventDefault(); break;
    }
  }

  // ── Message handling ────────────────────────────────────────────────────
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
      case MSG.PONG: break;
    }
  }

  _applySnapshot(snap) {
    if (snap.vectorClock) this.vectorClock = VectorClock.fromJSON(snap.vectorClock);
    for (const [id, data] of Object.entries(snap.objects || {})) {
      const obj = CRDTObject.fromJSON(data);
      this.objects.set(id, obj);
      this._createMesh(obj);
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
    this._updateCursor(p.clientId, p.cursor);
    this._renderUsers();
  }

  _opCreate(op) {
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

  // ── Mesh management ─────────────────────────────────────────────────────
  _createMesh(obj) {
    const geo = obj.geometry === 'sphere'   ? new THREE.SphereGeometry(0.5, 32, 32)
              : obj.geometry === 'cylinder' ? new THREE.CylinderGeometry(0.5, 0.5, 1, 32)
              : new THREE.BoxGeometry(1, 1, 1);
    const mat  = new THREE.MeshStandardMaterial({ color: obj.metadata.color.value, roughness: 0.5, metalness: 0.5 });
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
    const p = obj.transform.position.value, r = obj.transform.rotation.value, s = obj.transform.scale.value;
    mesh.position.set(p.x, p.y, p.z);
    mesh.quaternion.set(r.x, r.y, r.z, r.w);
    mesh.scale.set(s.x, s.y, s.z);
  }

  _removeMesh(id) {
    const mesh = this.meshes.get(id);
    if (!mesh) return;
    this.scene.remove(mesh);
    mesh.geometry.dispose(); mesh.material.dispose();
    this.meshes.delete(id);
  }

  // ── Send operations ──────────────────────────────────────────────────────
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

    this._applyOp(op);   // optimistic local apply
    this._send(op);
  }

  addObject(geometry) {
    this._sendOp({
      op: OP.CREATE, objectId: generateId('obj'),
      objectData: {
        type: 'mesh', geometry,
        transform: {
          position: { value: { x: Math.random()*4-2, y:0.5, z: Math.random()*4-2 } },
          rotation: { value: { x:0, y:0, z:0, w:1 } },
          scale:    { value: { x:1, y:1, z:1 } },
        },
        metadata: {
          color: { value: '#'+Math.floor(Math.random()*16777215).toString(16).padStart(6,'0') },
          name:  { value: geometry + '-' + Date.now() },
        },
      },
    });
  }

  addCube()     { this.addObject('box');      }
  addSphere()   { this.addObject('sphere');   }
  addCylinder() { this.addObject('cylinder'); }

  moveObject(id, pos)   { this._sendOp({ op: OP.TRANSFORM, objectId: id, property: 'position', value: { x: pos.x, y: pos.y, z: pos.z } }); }

  rotateObject(id, dy) {
    const obj = this.objects.get(id); if (!obj) return;
    const q   = new THREE.Quaternion(obj.transform.rotation.value.x, obj.transform.rotation.value.y, obj.transform.rotation.value.z, obj.transform.rotation.value.w);
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), dy));
    this._sendOp({ op: OP.TRANSFORM, objectId: id, property: 'rotation', value: { x:q.x, y:q.y, z:q.z, w:q.w } });
  }

  scaleObject(id, f) {
    const obj = this.objects.get(id); if (!obj) return;
    const s = obj.transform.scale.value;
    this._sendOp({ op: OP.TRANSFORM, objectId: id, property: 'scale', value: { x:s.x*f, y:s.y*f, z:s.z*f } });
  }

  deleteSelected() {
    if (!this.selectedObject) return;
    this._sendOp({ op: OP.DELETE, objectId: this.selectedObject });
    this._deselect();
  }

  undo() { const op = this._undoStack.pop(); if (!op) return; this._redoStack.push(op); this._send({ type: 'undo', clientId: this.clientId, sceneId: this.sceneId }); }
  redo() { const op = this._redoStack.pop(); if (!op) return; this._undoStack.push(op); this._sendOp(op); }

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
            position: { value: { x: pos.x + (Math.random()*2-1), y: pos.y, z: pos.z + (Math.random()*2-1) } },
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

  async publishScene() {
    const token = getToken();
    if (!token) { alert('Sign in to publish.'); return; }
    const title = prompt('Model title:', 'My Scene'); if (!title) return;
    const description = prompt('Description (optional):', '') ?? '';
    try {
      // Step 1: Ensure scene exists in DB and save current snapshot
      const ensureRes  = await authPost('/scenes/ensure', {
        sceneId:  this.sceneId,
        name:     title,
        snapshot: this._buildSnapshot()
      });
      const ensureData = await ensureRes.json();
      if (!ensureRes.ok) throw new Error(ensureData.error || 'Could not save scene to server');

      // Step 2: Publish to library
      const pubRes  = await authPost('/models', {
        sceneId:     this.sceneId,
        title,
        description: description || undefined,
        tags:        []
      });
      const pubData = await pubRes.json();
      if (!pubRes.ok) throw new Error(pubData.error);
      alert(`✅ Published "${pubData.model.title}" to the library!\nOpen Library to see it.`);
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
      window.open(data.url, '_blank');
    } catch (err) { alert(`Export failed: ${err.message}`); }
  }

  // ── UI helpers ───────────────────────────────────────────────────────────
  _select(id) {
    this._deselect();
    this.selectedObject = id;
    this.selectedMesh   = this.meshes.get(id);
    if (this.selectedMesh) {
      this.selectedMesh.material = this.selectedMesh.material.clone();
      this.selectedMesh.material.emissive = new THREE.Color(0x4ECDC4);
      this.selectedMesh.material.emissiveIntensity = 0.3;
    }
    this._renderSelectedInfo();
  }

  _deselect() {
    if (this.selectedMesh) { this.selectedMesh.material.emissive.set(0x000000); this.selectedMesh.material.emissiveIntensity = 0; }
    this.selectedObject = null; this.selectedMesh = null;
    document.getElementById('selected-info').style.display = 'none';
  }

  _renderSelectedInfo() {
    const el = document.getElementById('selected-info');
    const d  = document.getElementById('selected-details');
    if (!this.selectedObject || !el) return;
    const obj = this.objects.get(this.selectedObject); if (!obj) return;
    el.style.display = 'block';
    const p = obj.transform.position.value;
    d.innerHTML = `
      <div class="info-row"><span class="info-label">ID</span><span>${obj.id.slice(0,12)}</span></div>
      <div class="info-row"><span class="info-label">Type</span><span>${obj.geometry}</span></div>
      <div class="info-row"><span class="info-label">Pos</span><span>${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}</span></div>
      <div class="info-row"><span class="info-label">Color</span><span style="background:${obj.metadata.color.value};padding:1px 8px;border-radius:3px">${obj.metadata.color.value}</span></div>
    `;
  }

  _updateCursor(clientId, cursor) {
    if (!cursor) return;
    let el = this.cursors.get(clientId);
    if (!el) {
      el = document.createElement('div'); el.className = 'cursor';
      const lbl = document.createElement('div'); lbl.className = 'cursor-label'; lbl.textContent = clientId.slice(0,8);
      el.appendChild(lbl); document.body.appendChild(el); this.cursors.set(clientId, el);
    }
    const u = this.users.get(clientId);
    if (u) el.style.backgroundColor = u.color;
    el.style.left = cursor.x + 'px'; el.style.top = cursor.y + 'px';
  }

  _removeCursor(clientId) { this.cursors.get(clientId)?.remove(); this.cursors.delete(clientId); }

  _renderUsers() {
    const list = document.getElementById('user-list'); if (!list) return;
    list.innerHTML = `<div class="user-item"><div class="user-dot" style="background:#4ECDC4"></div><span>${getUser()?.username || this.clientId.slice(0,10)} (you)</span></div>`;
    this.users.forEach((u, id) => {
      const item = document.createElement('div'); item.className = 'user-item';
      item.innerHTML = `<div class="user-dot" style="background:${u.color}"></div><span>${id.slice(0,10)}</span>`;
      list.appendChild(item);
    });
  }

  _setStatus(msg, ok) {
    const el = document.getElementById('status'); if (!el) return;
    el.textContent = msg; el.className = ok ? '' : 'disconnected';
  }

  _send(msg) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)); }

  _animate() { requestAnimationFrame(() => this._animate()); this.controls.update(); this.renderer.render(this.scene, this.camera); }
}

const app = new CollaborativeEditor();
window.app = app;