import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Import CRDT types
const { VectorClock, LWWRegister, CRDTObject, OperationType, MessageType, generateId } = await import('./types.js');

class CollaborativeClient {
  constructor() {
    this.clientId = generateId('user');
    this.sceneId = new URLSearchParams(window.location.search).get('scene') || 'default-scene';
    this.ws = null;
    this.vectorClock = new VectorClock();
    this.objects = new Map(); // objectId -> CRDTObject
    this.meshes = new Map(); // objectId -> THREE.Mesh
    this.selectedObject = null;
    this.users = new Map(); // clientId -> {color, cursor}
    this.cursors = new Map(); // clientId -> DOM element
    
    this.initThreeJS();
    this.initWebSocket();
    this.initControls();
    this.animate();
  }

  initThreeJS() {
    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a2e);
    this.scene.fog = new THREE.Fog(0x1a1a2e, 10, 50);

    // Camera
    this.camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      1000
    );
    this.camera.position.set(5, 5, 5);
    this.camera.lookAt(0, 0, 0);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.getElementById('canvas-container').appendChild(this.renderer.domElement);

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(5, 10, 5);
    directionalLight.castShadow = true;
    directionalLight.shadow.mapSize.width = 2048;
    directionalLight.shadow.mapSize.height = 2048;
    this.scene.add(directionalLight);

    // Ground plane
    const groundGeometry = new THREE.PlaneGeometry(20, 20);
    const groundMaterial = new THREE.MeshStandardMaterial({ 
      color: 0x16213e,
      roughness: 0.8,
      metalness: 0.2
    });
    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Grid helper
    const gridHelper = new THREE.GridHelper(20, 20, 0x4ECDC4, 0x2a2a3e);
    this.scene.add(gridHelper);

    // Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;

    // Raycaster for selection
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    // Handle window resize
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  initWebSocket() {
    const wsUrl = `ws://localhost:8080`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('Connected to server');
      this.updateStatus('Connected', true);
      
      // Join scene
      this.send({
        type: MessageType.JOIN,
        sceneId: this.sceneId,
        clientId: this.clientId,
        vectorClock: this.vectorClock.toJSON()
      });
    };

    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      this.handleMessage(message);
    };

    this.ws.onclose = () => {
      console.log('Disconnected from server');
      this.updateStatus('Disconnected', false);
      
      // Attempt reconnect
      setTimeout(() => this.initWebSocket(), 3000);
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    // Heartbeat
    setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.send({
          type: MessageType.PING,
          timestamp: Date.now()
        });
      }
    }, 30000);
  }

  initControls() {
    // Mouse events
    this.renderer.domElement.addEventListener('click', (e) => this.onClick(e));
    this.renderer.domElement.addEventListener('mousemove', (e) => this.onMouseMove(e));

    // Keyboard events
    window.addEventListener('keydown', (e) => this.onKeyDown(e));

    // Drag controls
    let isDragging = false;
    let dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    let dragOffset = new THREE.Vector3();

    this.renderer.domElement.addEventListener('mousedown', (e) => {
      if (e.button === 0 && this.selectedObject && !e.shiftKey) {
        isDragging = true;
        this.controls.enabled = false;

        // Calculate drag offset
        const intersects = this.raycaster.intersectObject(this.selectedMesh);
        if (intersects.length > 0) {
          dragOffset.copy(intersects[0].point).sub(this.selectedMesh.position);
        }
      }
    });

    this.renderer.domElement.addEventListener('mousemove', (e) => {
      if (isDragging && this.selectedObject) {
        this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);
        const intersectPoint = new THREE.Vector3();
        this.raycaster.ray.intersectPlane(dragPlane, intersectPoint);

        if (intersectPoint) {
          const newPos = intersectPoint.sub(dragOffset);
          this.moveObject(this.selectedObject, newPos);
        }
      }
    });

    this.renderer.domElement.addEventListener('mouseup', () => {
      isDragging = false;
      this.controls.enabled = true;
    });
  }

  onClick(event) {
    this.mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    this.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObjects(
      Array.from(this.meshes.values()).filter(m => m !== this.selectedMesh)
    );

    if (intersects.length > 0) {
      this.selectObject(intersects[0].object.userData.objectId);
    } else {
      this.deselectObject();
    }
  }

  onMouseMove(event) {
    // Send cursor position
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({
        type: MessageType.PRESENCE,
        sceneId: this.sceneId,
        clientId: this.clientId,
        cursor: { x: event.clientX, y: event.clientY },
        selectedObjects: this.selectedObject ? [this.selectedObject] : []
      });
    }
  }

  onKeyDown(event) {
    if (!this.selectedObject) return;

    const obj = this.objects.get(this.selectedObject);
    if (!obj) return;

    switch (event.key.toLowerCase()) {
      case 'q': // Rotate left
        this.rotateObject(this.selectedObject, -0.1);
        break;
      case 'e': // Rotate right
        this.rotateObject(this.selectedObject, 0.1);
        break;
      case 'w': // Scale up
        this.scaleObject(this.selectedObject, 1.1);
        break;
      case 's': // Scale down
        this.scaleObject(this.selectedObject, 0.9);
        break;
      case 'delete':
      case 'backspace':
        this.deleteSelected();
        event.preventDefault();
        break;
    }
  }

  selectObject(objectId) {
    this.deselectObject();
    this.selectedObject = objectId;
    this.selectedMesh = this.meshes.get(objectId);

    if (this.selectedMesh) {
      this.selectedMesh.material = this.selectedMesh.material.clone();
      this.selectedMesh.material.emissive = new THREE.Color(0x4ECDC4);
      this.selectedMesh.material.emissiveIntensity = 0.3;
    }

    this.updateSelectedInfo();
  }

  deselectObject() {
    if (this.selectedMesh) {
      this.selectedMesh.material.emissive = new THREE.Color(0x000000);
      this.selectedMesh.material.emissiveIntensity = 0;
    }
    this.selectedObject = null;
    this.selectedMesh = null;
    document.getElementById('selected-info').style.display = 'none';
  }

  handleMessage(message) {
    switch (message.type) {
      case MessageType.SNAPSHOT:
        this.handleSnapshot(message);
        break;
      case MessageType.OPERATION:
        this.handleOperation(message);
        break;
      case MessageType.PRESENCE:
        this.handlePresence(message);
        break;
      case 'user_joined':
        console.log('User joined:', message.clientId);
        break;
      case 'user_left':
        console.log('User left:', message.clientId);
        this.users.delete(message.clientId);
        this.removeCursor(message.clientId);
        this.updateUserList();
        break;
      case MessageType.PONG:
        const latency = Date.now() - message.timestamp;
        console.log(`Latency: ${latency}ms`);
        break;
    }
  }

  handleSnapshot(snapshot) {
    console.log('Received snapshot:', snapshot);
    
    // Update vector clock
    this.vectorClock = VectorClock.fromJSON(snapshot.vectorClock);

    // Load all objects
    for (const [objectId, objectData] of Object.entries(snapshot.objects)) {
      const obj = CRDTObject.fromJSON(objectData);
      this.objects.set(objectId, obj);
      this.createMesh(obj);
    }

    // Load presence
    snapshot.presence.forEach(presence => {
      if (presence.clientId !== this.clientId) {
        this.users.set(presence.clientId, {
          color: presence.color,
          cursor: presence.cursor
        });
      }
    });

    this.updateUserList();
  }

  handleOperation(operation) {
    console.log('Received operation:', operation);

    // Update vector clock
    this.vectorClock = this.vectorClock.merge(VectorClock.fromJSON(operation.vectorClock));
    this.vectorClock.increment(this.clientId);

    switch (operation.op) {
      case OperationType.CREATE:
        this.applyCreate(operation);
        break;
      case OperationType.DELETE:
        this.applyDelete(operation);
        break;
      case OperationType.TRANSFORM:
        this.applyTransform(operation);
        break;
      case OperationType.METADATA:
        this.applyMetadata(operation);
        break;
    }
  }

  handlePresence(presence) {
    if (presence.clientId === this.clientId) return;

    this.users.set(presence.clientId, {
      color: this.users.get(presence.clientId)?.color || '#FF6B6B',
      cursor: presence.cursor
    });

    this.updateCursor(presence.clientId, presence.cursor);
    this.updateUserList();
  }

  applyCreate(operation) {
    const obj = new CRDTObject(operation.objectId, operation.objectData.type, operation.objectData.geometry);
    
    if (operation.objectData.transform) {
      const { position, rotation, scale } = operation.objectData.transform;
      const vc = VectorClock.fromJSON(operation.vectorClock);
      
      if (position) obj.transform.position.set(position.value, operation.timestamp, operation.clientId, vc);
      if (rotation) obj.transform.rotation.set(rotation.value, operation.timestamp, operation.clientId, vc);
      if (scale) obj.transform.scale.set(scale.value, operation.timestamp, operation.clientId, vc);
    }

    if (operation.objectData.metadata) {
      const vc = VectorClock.fromJSON(operation.vectorClock);
      for (const [key, data] of Object.entries(operation.objectData.metadata)) {
        if (obj.metadata[key]) {
          obj.metadata[key].set(data.value, operation.timestamp, operation.clientId, vc);
        }
      }
    }

    this.objects.set(operation.objectId, obj);
    this.createMesh(obj);
  }

  applyDelete(operation) {
    const obj = this.objects.get(operation.objectId);
    if (obj) {
      obj.delete(operation.timestamp, operation.clientId, VectorClock.fromJSON(operation.vectorClock));
      this.removeMesh(operation.objectId);
      
      if (this.selectedObject === operation.objectId) {
        this.deselectObject();
      }
    }
  }

  applyTransform(operation) {
    const obj = this.objects.get(operation.objectId);
    if (obj && !obj.isDeleted()) {
      obj.updateProperty(
        `transform.${operation.property}`,
        operation.value,
        operation.timestamp,
        operation.clientId,
        VectorClock.fromJSON(operation.vectorClock)
      );
      this.updateMesh(obj);
    }
  }

  applyMetadata(operation) {
    const obj = this.objects.get(operation.objectId);
    if (obj && !obj.isDeleted()) {
      obj.updateProperty(
        `metadata.${operation.property}`,
        operation.value,
        operation.timestamp,
        operation.clientId,
        VectorClock.fromJSON(operation.vectorClock)
      );
      this.updateMesh(obj);
    }
  }

  createMesh(obj) {
    let geometry;
    switch (obj.geometry) {
      case 'sphere':
        geometry = new THREE.SphereGeometry(0.5, 32, 32);
        break;
      case 'cylinder':
        geometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 32);
        break;
      default: // cube
        geometry = new THREE.BoxGeometry(1, 1, 1);
    }

    const material = new THREE.MeshStandardMaterial({
      color: obj.metadata.color.value,
      roughness: 0.5,
      metalness: 0.5
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.objectId = obj.id;

    const pos = obj.transform.position.value;
    const rot = obj.transform.rotation.value;
    const scale = obj.transform.scale.value;

    mesh.position.set(pos.x, pos.y, pos.z);
    mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
    mesh.scale.set(scale.x, scale.y, scale.z);

    this.scene.add(mesh);
    this.meshes.set(obj.id, mesh);
  }

  updateMesh(obj) {
    const mesh = this.meshes.get(obj.id);
    if (!mesh) return;

    const pos = obj.transform.position.value;
    const rot = obj.transform.rotation.value;
    const scale = obj.transform.scale.value;

    mesh.position.set(pos.x, pos.y, pos.z);
    mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
    mesh.scale.set(scale.x, scale.y, scale.z);
    mesh.material.color.set(obj.metadata.color.value);

    if (this.selectedObject === obj.id) {
      this.updateSelectedInfo();
    }
  }

  removeMesh(objectId) {
    const mesh = this.meshes.get(objectId);
    if (mesh) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
      this.meshes.delete(objectId);
    }
  }

  sendOperation(operation) {
    this.vectorClock.increment(this.clientId);
    operation.vectorClock = this.vectorClock.toJSON();
    operation.timestamp = Date.now();
    operation.clientId = this.clientId;
    operation.sceneId = this.sceneId;
    operation.type = MessageType.OPERATION;

    // Apply optimistically
    this.handleOperation(operation);

    // Send to server
    this.send(operation);
  }

  addObject(geometry) {
    const objectId = generateId('obj');
    const color = '#' + Math.floor(Math.random() * 16777215).toString(16);
    
    const operation = {
      op: OperationType.CREATE,
      objectId,
      objectData: {
        type: 'mesh',
        geometry,
        transform: {
          position: { value: { x: Math.random() * 4 - 2, y: 0.5, z: Math.random() * 4 - 2 } },
          rotation: { value: { x: 0, y: 0, z: 0, w: 1 } },
          scale: { value: { x: 1, y: 1, z: 1 } }
        },
        metadata: {
          color: { value: color },
          name: { value: `${geometry} ${Date.now()}` }
        }
      }
    };

    this.sendOperation(operation);
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

    const currentRot = obj.transform.rotation.value;
    const quaternion = new THREE.Quaternion(currentRot.x, currentRot.y, currentRot.z, currentRot.w);
    const axis = new THREE.Vector3(0, 1, 0);
    const rotation = new THREE.Quaternion().setFromAxisAngle(axis, deltaY);
    quaternion.multiply(rotation);

    this.sendOperation({
      op: OperationType.TRANSFORM,
      objectId,
      property: 'rotation',
      value: { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w }
    });
  }

  scaleObject(objectId, factor) {
    const obj = this.objects.get(objectId);
    if (!obj) return;

    const currentScale = obj.transform.scale.value;
    this.sendOperation({
      op: OperationType.TRANSFORM,
      objectId,
      property: 'scale',
      value: {
        x: currentScale.x * factor,
        y: currentScale.y * factor,
        z: currentScale.z * factor
      }
    });
  }

  addCube() {
    this.addObject('box');
  }

  addSphere() {
    this.addObject('sphere');
  }

  addCylinder() {
    this.addObject('cylinder');
  }

  deleteSelected() {
    if (!this.selectedObject) return;

    this.sendOperation({
      op: OperationType.DELETE,
      objectId: this.selectedObject
    });

    this.deselectObject();
  }

  updateCursor(clientId, cursor) {
    if (!cursor) return;

    let cursorEl = this.cursors.get(clientId);
    if (!cursorEl) {
      cursorEl = document.createElement('div');
      cursorEl.className = 'cursor';
      const label = document.createElement('div');
      label.className = 'cursor-label';
      label.textContent = clientId.substring(0, 8);
      cursorEl.appendChild(label);
      document.body.appendChild(cursorEl);
      this.cursors.set(clientId, cursorEl);
    }

    const user = this.users.get(clientId);
    if (user) {
      cursorEl.style.backgroundColor = user.color;
    }

    cursorEl.style.left = cursor.x + 'px';
    cursorEl.style.top = cursor.y + 'px';
  }

  removeCursor(clientId) {
    const cursorEl = this.cursors.get(clientId);
    if (cursorEl) {
      cursorEl.remove();
      this.cursors.delete(clientId);
    }
  }

  updateUserList() {
    const userList = document.getElementById('user-list');
    userList.innerHTML = '';

    // Add self
    const selfItem = document.createElement('div');
    selfItem.className = 'user-item';
    selfItem.innerHTML = `
      <div class="user-color" style="background: #4ECDC4"></div>
      <span>${this.clientId.substring(0, 12)} (you)</span>
    `;
    userList.appendChild(selfItem);

    // Add others
    this.users.forEach((user, clientId) => {
      const item = document.createElement('div');
      item.className = 'user-item';
      item.innerHTML = `
        <div class="user-color" style="background: ${user.color}"></div>
        <span>${clientId.substring(0, 12)}</span>
      `;
      userList.appendChild(item);
    });
  }

  updateSelectedInfo() {
    const infoEl = document.getElementById('selected-info');
    const detailsEl = document.getElementById('selected-details');

    if (!this.selectedObject) {
      infoEl.style.display = 'none';
      return;
    }

    const obj = this.objects.get(this.selectedObject);
    if (!obj) return;

    infoEl.style.display = 'block';
    const pos = obj.transform.position.value;
    const scale = obj.transform.scale.value;

    detailsEl.innerHTML = `
      <div class="info-row">
        <span class="info-label">ID:</span>
        <span>${obj.id.substring(0, 12)}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Type:</span>
        <span>${obj.geometry}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Position:</span>
        <span>${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Scale:</span>
        <span>${scale.x.toFixed(2)}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Color:</span>
        <span style="background: ${obj.metadata.color.value}; padding: 2px 8px; border-radius: 3px;">${obj.metadata.color.value}</span>
      </div>
    `;
  }

  updateStatus(message, connected) {
    const statusEl = document.getElementById('status');
    statusEl.textContent = message;
    statusEl.className = connected ? 'connected' : 'disconnected';
  }

  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

// Start the application
const app = new CollaborativeClient();
window.app = app; // Make available globally for button handlers
