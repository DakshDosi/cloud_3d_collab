// client/client.js
// Main editor: Three.js renderer + CRDT store + WebSocket client
// All original CRDT logic preserved. Auth + history panel added on top.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { auth } from './js/authManager.js';
import { HistoryPanel } from './components/historyPanel.js';

// ── Import CRDT types from server/types.js via HTTP
// (In production, share via a bundler or copy to client/types.js)
const {
  VectorClock,
  LWWRegister,
  CRDTObject,
  OperationType,
  MessageType,
  generateId
} = await import('./types.js');

// ═══════════════════════════════════════════════════════
// CollaborativeClient
// ═══════════════════════════════════════════════════════

class CollaborativeClient {
  constructor() {
    this.clientId       = generateId('user');
    this.sceneId        = new URLSearchParams(window.location.search).get('scene') || 'default-scene';
    this.ws             = null;
    this.vectorClock    = new VectorClock();
    this.objects        = new Map();   // objectId → CRDTObject
    this.meshes         = new Map();   // objectId → THREE.Mesh
    this.selectedObject = null;
    this.selectedMesh   = null;
    this.users          = new Map();   // clientId → { color, cursor }
    this.cursors        = new Map();   // clientId → DOM element
    this.undoStack      = [];
    this.redoStack      = [];

    this.initThreeJS();
    this.initWebSocket();
    this.initControls();
    this.initHistoryPanel();
    this.checkPendingImport();
    this.animate();
  }

  // ── Three.js setup ─────────────────────────────────────────────────────────

  initThreeJS() {
    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a2e);
    this.scene.fog = new THREE.Fog(0x1a1a2e, 10, 50);

    // Camera
    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.camera.position.set(5, 5, 5);
    this.camera.lookAt(0, 0, 0);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.getElementById('canvas-container').appendChild(this.renderer.domElement);

    // Lights
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(5, 10, 5);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    this.scene.add(dirLight);

    // Ground
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(20, 20),
      new THREE.MeshStandardMaterial({ color: 0x16213e, roughness: 0.8, metalness: 0.2 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.scene.add(new THREE.GridHelper(20, 20, 0x4ECDC4, 0x2a2a3e));

    // Orbit controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;

    // Raycaster
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    // Resize
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────

  initWebSocket() {
    const host  = `ws://${location.hostname}:8080`;
    const token = auth.getToken();
    const url   = token ? `${host}?token=${token}` : host;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.updateStatus('Connected', true);
      this.send({
        type:        MessageType.JOIN,
        sceneId:     this.sceneId,
        clientId:    this.clientId,
        vectorClock: this.vectorClock.toJSON()
      });
    };

    this.ws.onmessage = (e) => {
      try {
        this.handleMessage(JSON.parse(e.data));
      } catch (err) {
        console.error('WS parse error:', err);
      }
    };

    this.ws.onclose = () => {
      this.updateStatus('Disconnected — reconnecting…', false);
      setTimeout(() => this.initWebSocket(), 3000);
    };

    this.ws.onerror = (e) => console.error('WS error:', e);

    // Heartbeat
    setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.send({ type: MessageType.PING, timestamp: Date.now() });
      }
    }, 30000);
  }

  // ── Mouse / Keyboard controls ──────────────────────────────────────────────

  initControls() {
    const canvas = this.renderer.domElement;

    canvas.addEventListener('click',     (e) => this.onClick(e));
    canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('keydown',   (e) => this.onKeyDown(e));

    // Drag to move objects on ground plane
    let dragging  = false;
    const plane   = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const offset  = new THREE.Vector3();

    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !this.selectedObject || e.shiftKey) return;
      dragging = true;
      this.controls.enabled = false;
      const hits = this.raycaster.intersectObject(this.selectedMesh);
      if (hits.length > 0) offset.copy(hits[0].point).sub(this.selectedMesh.position);
    });

    canvas.addEventListener('mousemove', (e) => {
      if (!dragging || !this.selectedObject) return;
      this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
      this.raycaster.setFromCamera(this.mouse, this.camera);
      const pt = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(plane, pt)) {
        this.moveObject(this.selectedObject, pt.sub(offset));
      }
    });

    canvas.addEventListener('mouseup', () => {
      dragging = false;
      this.controls.enabled = true;
    });
  }

  onClick(e) {
    this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);

    const meshList = [...this.meshes.values()].filter(m => m !== this.selectedMesh);
    const hits     = this.raycaster.intersectObjects(meshList);

    if (hits.length > 0) {
      this.selectObject(hits[0].object.userData.objectId);
    } else {
      this.deselectObject();
    }
  }

  onMouseMove(e) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.send({
      type:            MessageType.PRESENCE,
      sceneId:         this.sceneId,
      clientId:        this.clientId,
      cursor:          { x: e.clientX, y: e.clientY },
      selectedObjects: this.selectedObject ? [this.selectedObject] : []
    });
  }

  onKeyDown(e) {
    // Ctrl/Cmd + Z = undo, + Shift + Z = redo
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.shiftKey ? this.redo() : this.undo();
      e.preventDefault();
      return;
    }
    if (!this.selectedObject) return;
    switch (e.key.toLowerCase()) {
      case 'q':         this.rotateObject(this.selectedObject, -0.1); break;
      case 'e':         this.rotateObject(this.selectedObject,  0.1); break;
      case 'w':         this.scaleObject(this.selectedObject, 1.1);   break;
      case 's':         this.scaleObject(this.selectedObject, 0.9);   break;
      case 'delete':
      case 'backspace':
        this.deleteSelected();
        e.preventDefault();
        break;
    }
  }

  // ── Message handling ───────────────────────────────────────────────────────

  handleMessage(msg) {
    switch (msg.type) {
      case MessageType.SNAPSHOT:  this.handleSnapshot(msg);   break;
      case MessageType.OPERATION: this.handleOperation(msg);  break;
      case MessageType.PRESENCE:  this.handlePresence(msg);   break;
      case MessageType.PONG:      /* latency tracking */       break;
      case 'user_joined':                                      break;
      case 'user_left':
        this.users.delete(msg.clientId);
        this.removeCursor(msg.clientId);
        this.updateUserList();
        break;
    }
  }

  handleSnapshot(snap) {
    this.vectorClock = VectorClock.fromJSON(snap.vectorClock || {});

    for (const [id, data] of Object.entries(snap.objects || {})) {
      const obj = CRDTObject.fromJSON(data);
      this.objects.set(id, obj);
      this.createMesh(obj);
    }

    (snap.presence || []).forEach(p => {
      if (p.clientId !== this.clientId) {
        this.users.set(p.clientId, { color: p.color || '#FF6B6B', cursor: p.cursor });
      }
    });

    this.updateUserList();
  }

  handleOperation(op) {
    this.vectorClock = this.vectorClock.merge(VectorClock.fromJSON(op.vectorClock || {}));
    this.vectorClock.increment(this.clientId);

    switch (op.op) {
      case OperationType.CREATE:    this.applyCreate(op);    break;
      case OperationType.DELETE:    this.applyDelete(op);    break;
      case OperationType.TRANSFORM: this.applyTransform(op); break;
      case OperationType.METADATA:  this.applyMetadata(op);  break;
    }
  }

  handlePresence(p) {
    if (p.clientId === this.clientId) return;
    this.users.set(p.clientId, {
      color:  this.users.get(p.clientId)?.color || '#FF6B6B',
      cursor: p.cursor
    });
    this.updateCursor(p.clientId, p.cursor);
    this.updateUserList();
  }

  // ── CRDT apply operations ──────────────────────────────────────────────────

  applyCreate(op) {
    const obj = new CRDTObject(op.objectId, op.objectData.type, op.objectData.geometry);
    const vc  = VectorClock.fromJSON(op.vectorClock || {});
    const t   = op.objectData.transform || {};

    if (t.position) obj.transform.position.set(t.position.value, op.timestamp, op.clientId, vc);
    if (t.rotation) obj.transform.rotation.set(t.rotation.value, op.timestamp, op.clientId, vc);
    if (t.scale)    obj.transform.scale.set(t.scale.value,       op.timestamp, op.clientId, vc);

    for (const [key, val] of Object.entries(op.objectData.metadata || {})) {
      if (obj.metadata[key]) obj.metadata[key].set(val.value, op.timestamp, op.clientId, vc);
    }

    this.objects.set(op.objectId, obj);
    this.createMesh(obj);
  }

  applyDelete(op) {
    const obj = this.objects.get(op.objectId);
    if (!obj) return;
    obj.delete(op.timestamp, op.clientId, VectorClock.fromJSON(op.vectorClock || {}));
    this.removeMesh(op.objectId);
    if (this.selectedObject === op.objectId) this.deselectObject();
  }

  applyTransform(op) {
    const obj = this.objects.get(op.objectId);
    if (!obj || obj.isDeleted()) return;
    obj.updateProperty(
      `transform.${op.property}`,
      op.value, op.timestamp, op.clientId,
      VectorClock.fromJSON(op.vectorClock || {})
    );
    this.updateMesh(obj);
  }

  applyMetadata(op) {
    const obj = this.objects.get(op.objectId);
    if (!obj || obj.isDeleted()) return;
    obj.updateProperty(
      `metadata.${op.property}`,
      op.value, op.timestamp, op.clientId,
      VectorClock.fromJSON(op.vectorClock || {})
    );
    this.updateMesh(obj);
  }

  // ── Mesh management ────────────────────────────────────────────────────────

  createMesh(obj) {
    let geo;
    switch (obj.geometry) {
      case 'sphere':   geo = new THREE.SphereGeometry(0.5, 32, 32);        break;
      case 'cylinder': geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 32); break;
      default:         geo = new THREE.BoxGeometry(1, 1, 1);
    }

    const mat  = new THREE.MeshStandardMaterial({
      color: obj.metadata.color.value || '#4ECDC4',
      roughness: 0.5,
      metalness: 0.5
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData.objectId = obj.id;

    const pos = obj.transform.position.value;
    const rot = obj.transform.rotation.value;
    const sc  = obj.transform.scale.value;
    mesh.position.set(pos.x, pos.y, pos.z);
    mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
    mesh.scale.set(sc.x, sc.y, sc.z);

    this.scene.add(mesh);
    this.meshes.set(obj.id, mesh);
  }

  updateMesh(obj) {
    const mesh = this.meshes.get(obj.id);
    if (!mesh) return;
    const pos = obj.transform.position.value;
    const rot = obj.transform.rotation.value;
    const sc  = obj.transform.scale.value;
    mesh.position.set(pos.x, pos.y, pos.z);
    mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
    mesh.scale.set(sc.x, sc.y, sc.z);
    mesh.material.color.set(obj.metadata.color.value || '#4ECDC4');
    if (this.selectedObject === obj.id) this.updateSelectedInfo();
  }

  removeMesh(objectId) {
    const mesh = this.meshes.get(objectId);
    if (!mesh) return;
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
    this.meshes.delete(objectId);
  }

  // ── Send operations ────────────────────────────────────────────────────────

  sendOperation(op) {
    this.vectorClock.increment(this.clientId);
    op.vectorClock = this.vectorClock.toJSON();
    op.timestamp   = Date.now();
    op.clientId    = this.clientId;
    op.sceneId     = this.sceneId;
    op.type        = MessageType.OPERATION;

    // Push to undo stack
    this.undoStack.push(JSON.parse(JSON.stringify(op)));
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];

    this.handleOperation(op); // optimistic local apply
    this.send(op);
  }

  // ── Public object actions ──────────────────────────────────────────────────

  addCube()     { this.addObject('box');      }
  addSphere()   { this.addObject('sphere');   }
  addCylinder() { this.addObject('cylinder'); }

  addObject(geometry) {
    const objectId = generateId('obj');
    const color    = '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
    this.sendOperation({
      op: OperationType.CREATE,
      objectId,
      objectData: {
        type: 'mesh',
        geometry,
        transform: {
          position: { value: { x: (Math.random() * 4) - 2, y: 0.5, z: (Math.random() * 4) - 2 } },
          rotation: { value: { x: 0, y: 0, z: 0, w: 1 } },
          scale:    { value: { x: 1, y: 1, z: 1 } }
        },
        metadata: {
          color: { value: color },
          name:  { value: `${geometry}-${Date.now()}` }
        }
      }
    });
  }

  moveObject(objectId, position) {
    this.sendOperation({
      op: OperationType.TRANSFORM,
      objectId,
      property: 'position',
      value: { x: position.x, y: position.y, z: position.z }
    });
  }

  rotateObject(objectId, deltaY) {
    const obj = this.objects.get(objectId);
    if (!obj) return;
    const r = obj.transform.rotation.value;
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), deltaY));
    this.sendOperation({
      op: OperationType.TRANSFORM,
      objectId,
      property: 'rotation',
      value: { x: q.x, y: q.y, z: q.z, w: q.w }
    });
  }

  scaleObject(objectId, factor) {
    const obj = this.objects.get(objectId);
    if (!obj) return;
    const s = obj.transform.scale.value;
    this.sendOperation({
      op: OperationType.TRANSFORM,
      objectId,
      property: 'scale',
      value: { x: s.x * factor, y: s.y * factor, z: s.z * factor }
    });
  }

  deleteSelected() {
    if (!this.selectedObject) return;
    this.sendOperation({ op: OperationType.DELETE, objectId: this.selectedObject });
    this.deselectObject();
  }

  // ── Undo / Redo ────────────────────────────────────────────────────────────

  undo() {
    const op = this.undoStack.pop();
    if (!op) return;
    this.redoStack.push(op);
    this.send({ type: MessageType.UNDO, clientId: this.clientId, sceneId: this.sceneId });
  }

  redo() {
    const op = this.redoStack.pop();
    if (!op) return;
    this.undoStack.push(op);
    this.sendOperation(op);
  }

  // ── Model library import ───────────────────────────────────────────────────

  importSnapshot(snapshot) {
    if (!snapshot?.objects) return;
    for (const data of Object.values(snapshot.objects)) {
      const src    = CRDTObject.fromJSON(data);
      const newId  = generateId('obj');
      const pos    = src.transform.position.value;
      this.sendOperation({
        op: OperationType.CREATE,
        objectId: newId,
        objectData: {
          type:     src.type,
          geometry: src.geometry,
          transform: {
            position: { value: { x: pos.x + (Math.random() - 0.5), y: pos.y, z: pos.z + (Math.random() - 0.5) } },
            rotation: { value: src.transform.rotation.value },
            scale:    { value: src.transform.scale.value }
          },
          metadata: {
            color: { value: src.metadata.color.value },
            name:  { value: `${src.metadata.name.value} (imported)` }
          }
        }
      });
    }
  }

  checkPendingImport() {
    const raw = sessionStorage.getItem('pendingImport');
    if (!raw) return;
    sessionStorage.removeItem('pendingImport');
    setTimeout(() => {
      try { this.importSnapshot(JSON.parse(raw)); } catch {}
    }, 1200);
  }

  // ── Publish scene as model ─────────────────────────────────────────────────

  async publishScene() {
    if (!auth.isLoggedIn()) {
      alert('Sign in to publish models.');
      return;
    }
    const title = prompt('Model title:', `Scene ${new Date().toLocaleDateString()}`);
    if (!title) return;
    const description = prompt('Description (optional):', '') || '';

    try {
      const res  = await auth.authPost('/api/models', { sceneId: this.sceneId, title, description });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      alert(`✅ Published: "${data.model.title}"`);
    } catch (err) {
      alert(`Publish failed: ${err.message}`);
    }
  }

  // ── Export scene ───────────────────────────────────────────────────────────

  async exportScene(format = 'json') {
    if (!auth.isLoggedIn()) { alert('Sign in to export.'); return; }
    try {
      const res  = await auth.authPost(`/api/scenes/${this.sceneId}/export`, { format });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      window.open(data.url, '_blank');
    } catch (err) {
      alert(`Export failed: ${err.message}`);
    }
  }

  // ── History panel ──────────────────────────────────────────────────────────

  initHistoryPanel() {
    this.historyPanel = new HistoryPanel(
      this.sceneId,
      auth.getToken(),
      (snapshot) => {
        // Clear scene and reload from restored snapshot
        [...this.meshes.keys()].forEach(id => this.removeMesh(id));
        this.objects.clear();
        this.handleSnapshot({ vectorClock: {}, objects: snapshot.objects || {}, presence: [] });
      }
    );

    document.getElementById('btnHistory')?.addEventListener('click', () => {
      this.historyPanel.toggle();
    });
  }

  // ── Selection ──────────────────────────────────────────────────────────────

  selectObject(objectId) {
    this.deselectObject();
    this.selectedObject = objectId;
    this.selectedMesh   = this.meshes.get(objectId);
    if (this.selectedMesh) {
      this.selectedMesh.material = this.selectedMesh.material.clone();
      this.selectedMesh.material.emissive          = new THREE.Color(0x4ECDC4);
      this.selectedMesh.material.emissiveIntensity = 0.3;
    }
    this.updateSelectedInfo();
  }

  deselectObject() {
    if (this.selectedMesh) {
      this.selectedMesh.material.emissive          = new THREE.Color(0x000000);
      this.selectedMesh.material.emissiveIntensity = 0;
    }
    this.selectedObject = null;
    this.selectedMesh   = null;
    const el = document.getElementById('selected-info');
    if (el) el.style.display = 'none';
  }

  // ── UI updates ─────────────────────────────────────────────────────────────

  updateStatus(msg, connected) {
    const el = document.getElementById('status');
    if (!el) return;
    el.textContent = msg;
    el.className   = connected ? 'connected' : 'disconnected';
  }

  updateUserList() {
    const list = document.getElementById('user-list');
    if (!list) return;
    list.innerHTML = '';

    // Self
    const selfEl = document.createElement('div');
    selfEl.className = 'user-item';
    selfEl.innerHTML = `
      <div class="user-color" style="background:#4ECDC4"></div>
      <span>${(auth.getUsername() || this.clientId).substring(0, 12)} (you)</span>
    `;
    list.appendChild(selfEl);

    // Others
    this.users.forEach((user, clientId) => {
      const el = document.createElement('div');
      el.className = 'user-item';
      el.innerHTML = `
        <div class="user-color" style="background:${user.color}"></div>
        <span>${clientId.substring(0, 12)}</span>
      `;
      list.appendChild(el);
    });
  }

  updateSelectedInfo() {
    const info    = document.getElementById('selected-info');
    const details = document.getElementById('selected-details');
    if (!info || !this.selectedObject) return;
    const obj = this.objects.get(this.selectedObject);
    if (!obj) return;
    info.style.display = 'block';
    const pos = obj.transform.position.value;
    const sc  = obj.transform.scale.value;
    details.innerHTML = `
      <div class="info-row"><span class="info-label">ID</span><span>${obj.id.slice(0, 10)}…</span></div>
      <div class="info-row"><span class="info-label">Geometry</span><span>${obj.geometry}</span></div>
      <div class="info-row"><span class="info-label">Position</span><span>${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}</span></div>
      <div class="info-row"><span class="info-label">Scale</span><span>${sc.x.toFixed(2)}</span></div>
      <div class="info-row"><span class="info-label">Color</span>
        <span style="background:${obj.metadata.color.value};padding:1px 8px;border-radius:3px">${obj.metadata.color.value}</span>
      </div>
    `;
  }

  updateCursor(clientId, cursor) {
    if (!cursor) return;
    let el = this.cursors.get(clientId);
    if (!el) {
      el = document.createElement('div');
      el.className = 'cursor';
      const label = document.createElement('div');
      label.className = 'cursor-label';
      label.textContent = clientId.substring(0, 8);
      el.appendChild(label);
      document.body.appendChild(el);
      this.cursors.set(clientId, el);
    }
    const user = this.users.get(clientId);
    if (user) el.style.background = user.color;
    el.style.left = cursor.x + 'px';
    el.style.top  = cursor.y + 'px';
  }

  removeCursor(clientId) {
    const el = this.cursors.get(clientId);
    if (el) { el.remove(); this.cursors.delete(clientId); }
  }

  // ── Send helper ────────────────────────────────────────────────────────────

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // ── Render loop ────────────────────────────────────────────────────────────

  animate() {
    requestAnimationFrame(() => this.animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
const app = new CollaborativeClient();
window.app = app; // expose for inline button handlers