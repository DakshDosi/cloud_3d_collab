// client/js/gestureController.js
// Hand gesture control for the 3D editor using MediaPipe Hands (browser-native).
// No server changes needed. Drop this file in and import it from client.js.
//
// HOW IT WORKS:
//   1. MediaPipe detects 21 landmarks per hand from the webcam feed.
//   2. We classify each hand's posture into one of 6 gestures every frame.
//   3. The controller fires events (grab, release, move, rotate, scale, delete, create)
//      that client.js already knows how to handle.
//
// GESTURE MAP:
//   Open palm      → cursor moves (wrist position mapped to canvas)
//   Pinch (1 hand) → grab / release object under cursor
//   Fist           → rotate held object (wrist yaw → Y axis)
//   Two-hand pinch → scale held object (distance between wrists)
//   Victory ✌️    → delete selected (hold 1 second)
//   Thumbs up 👍  → add cube at cursor position

const MEDIAPIPE_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/hands.js';
const CAMERA_CDN    = 'https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils@0.3.1675466862/camera_utils.js';

// ── Landmark indices (MediaPipe Hands convention) ──────────────────────────
const LM = {
  WRIST: 0,
  THUMB_TIP: 4, THUMB_IP: 3, THUMB_MCP: 2,
  INDEX_TIP: 8, INDEX_PIP: 6, INDEX_MCP: 5,
  MIDDLE_TIP: 12, MIDDLE_PIP: 10,
  RING_TIP: 16, RING_PIP: 14,
  PINKY_TIP: 20, PINKY_PIP: 18,
};

// ── Gesture classifier ─────────────────────────────────────────────────────
function classifyGesture(lms) {
  const extended = fingerExtended(lms);
  const [thumb, index, middle, ring, pinky] = extended;
  const pinchDist = dist2D(lms[LM.THUMB_TIP], lms[LM.INDEX_TIP]);

  if (pinchDist < 0.06)                                        return 'PINCH';
  if (thumb && index && middle && !ring && !pinky)             return 'VICTORY'; // ✌️
  if (thumb && !index && !middle && !ring && !pinky)           return 'THUMBS_UP'; // 👍
  if (!thumb && !index && !middle && !ring && !pinky)          return 'FIST';
  if (thumb && index && middle && ring && pinky)               return 'OPEN_PALM';
  return 'OTHER';
}

function fingerExtended(lms) {
  const thumb  = lms[LM.THUMB_TIP].x > lms[LM.THUMB_IP].x; // horizontal check for thumb
  const index  = lms[LM.INDEX_TIP].y  < lms[LM.INDEX_PIP].y;
  const middle = lms[LM.MIDDLE_TIP].y < lms[LM.MIDDLE_PIP].y;
  const ring   = lms[LM.RING_TIP].y   < lms[LM.RING_PIP].y;
  const pinky  = lms[LM.PINKY_TIP].y  < lms[LM.PINKY_PIP].y;
  return [thumb, index, middle, ring, pinky];
}

function dist2D(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function wristPos(lms, canvasW, canvasH) {
  // Mirror X because webcam is mirrored, map [0,1] → canvas pixels
  return {
    x: (1 - lms[LM.WRIST].x) * canvasW,
    y: lms[LM.WRIST].y * canvasH,
  };
}

// ── Main controller class ──────────────────────────────────────────────────
export class GestureController {
  constructor(editor) {
    this.editor        = editor;
    this.active        = false;
    this.hands         = null;
    this.camera        = null;
    this.videoEl       = null;
    this.hud           = null;

    // State per hand (indexed by handIndex 0/1)
    this.prevGesture   = [null, null];
    this.grabbing      = [false, false];
    this.grabStart     = [null, null];     // wrist pos when grab started
    this.fistYaw       = [null, null];     // wrist x when fist started
    this.twoHandScale  = null;             // initial inter-wrist dist
    this.deleteTimer   = null;
    this.lastWrist     = [null, null];

    this._createHUD();
  }

  // ── Public: toggle on/off ──────────────────────────────────────────────
  async enable() {
    if (this.active) return;
    this.active = true;
    this.hud.style.display = 'flex';
    this._setHUDStatus('loading', 'Loading MediaPipe…');

    await this._loadScripts();
    await this._initMediaPipe();
    this._setHUDStatus('active', 'Gesture control active');
  }

  disable() {
    this.active = false;
    this.camera?.stop();
    this.videoEl?.remove();
    this.hud.style.display = 'none';
    this._clearDeleteTimer();
  }

  toggle() { this.active ? this.disable() : this.enable(); }

  // ── HUD (status + gesture feedback overlay) ────────────────────────────
  _createHUD() {
    const hud = document.createElement('div');
    hud.id = 'gesture-hud';
    hud.style.cssText = `
      display: none; position: fixed; bottom: 20px; left: 50%;
      transform: translateX(-50%); z-index: 500;
      background: rgba(15,17,23,.88); border: 1px solid #2d3748;
      border-radius: 12px; padding: 10px 18px; gap: 14px;
      align-items: center; font-family: system-ui, sans-serif;
      font-size: 13px; color: #e2e8f0; backdrop-filter: blur(10px);
      box-shadow: 0 8px 32px rgba(0,0,0,.4); min-width: 320px;
    `;

    hud.innerHTML = `
      <div id="gh-dot" style="width:8px;height:8px;border-radius:50%;background:#718096;flex-shrink:0;transition:background .2s"></div>
      <span id="gh-status" style="flex:1;color:#a0aec0">Initialising…</span>
      <span id="gh-gesture" style="font-weight:600;color:#4ECDC4;min-width:110px;text-align:right"></span>
      <div id="gh-preview" style="width:80px;height:60px;border-radius:6px;overflow:hidden;border:1px solid #2d3748;flex-shrink:0;background:#0f1117;position:relative">
        <canvas id="gh-canvas" width="80" height="60" style="width:100%;height:100%"></canvas>
        <div id="gh-hand-icon" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:22px;pointer-events:none"></div>
      </div>
      <button id="gh-close" style="background:rgba(255,255,255,.07);border:none;border-radius:6px;color:#a0aec0;padding:4px 8px;cursor:pointer;font-size:12px">✕ Off</button>
    `;

    document.body.appendChild(hud);
    this.hud = hud;

    hud.querySelector('#gh-close').addEventListener('click', () => this.disable());
    this.hudCanvas = hud.querySelector('#gh-canvas');
    this.hudCtx    = this.hudCanvas.getContext('2d');
    this.hudIcon   = hud.querySelector('#gh-hand-icon');
  }

  _setHUDStatus(state, text) {
    const dot = this.hud.querySelector('#gh-dot');
    const s   = this.hud.querySelector('#gh-status');
    s.textContent = text;
    dot.style.background = state === 'active' ? '#4ECDC4'
                         : state === 'loading' ? '#F6AD55'
                         : '#fc8181';
  }

  _setHUDGesture(name, emoji) {
    this.hud.querySelector('#gh-gesture').textContent = `${emoji} ${name}`;
    this.hudIcon.textContent = emoji;
  }

  // ── Script loader ─────────────────────────────────────────────────────
  _loadScripts() {
    return Promise.all([MEDIAPIPE_CDN, CAMERA_CDN].map(src => new Promise((res, rej) => {
      if (document.querySelector(`script[src="${src}"]`)) return res();
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    })));
  }

  // ── MediaPipe init ────────────────────────────────────────────────────
  async _initMediaPipe() {
    // Hidden video element for webcam feed
    this.videoEl = document.createElement('video');
    this.videoEl.style.cssText = 'position:fixed;bottom:90px;left:16px;width:160px;height:120px;border-radius:8px;border:1px solid #2d3748;object-fit:cover;z-index:499;transform:scaleX(-1);opacity:.7;pointer-events:none';
    document.body.appendChild(this.videoEl);

    this.hands = new Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`
    });

    this.hands.setOptions({
      maxNumHands:        2,
      modelComplexity:    1,
      minDetectionConfidence:  0.75,
      minTrackingConfidence:   0.65,
    });

    this.hands.onResults((results) => this._onResults(results));

    this.camera = new Camera(this.videoEl, {
      onFrame: async () => {
        if (!this.active) return;
        await this.hands.send({ image: this.videoEl });
      },
      width: 640, height: 480,
    });

    try {
      await this.camera.start();
      this._setHUDStatus('active', 'Show your hand to the camera');
    } catch (e) {
      this._setHUDStatus('error', 'Camera access denied');
      console.error('GestureController:', e);
    }
  }

  // ── Per-frame result handler ───────────────────────────────────────────
  _onResults(results) {
    if (!this.active) return;

    const { multiHandLandmarks = [], multiHandedness = [] } = results;

    // Draw skeleton on HUD preview
    this._drawPreview(results);

    if (multiHandLandmarks.length === 0) {
      this._setHUDGesture('No hand', '🖐');
      this._resetGrabState();
      return;
    }

    // Two-hand scale gesture (both hands pinching)
    if (multiHandLandmarks.length === 2) {
      const g0 = classifyGesture(multiHandLandmarks[0]);
      const g1 = classifyGesture(multiHandLandmarks[1]);
      if (g0 === 'PINCH' && g1 === 'PINCH') {
        this._handleTwoHandScale(multiHandLandmarks[0], multiHandLandmarks[1]);
        this._setHUDGesture('Scale', '🤏🤏');
        return;
      }
    }
    this.twoHandScale = null;

    // Per-hand processing (use first detected hand as primary)
    multiHandLandmarks.forEach((lms, i) => {
      if (i > 0) return; // Phase 1: primary hand only for single-hand gestures
      const gesture = classifyGesture(lms);
      this._handleGesture(gesture, lms, i);
    });
  }

  // ── Gesture → editor action ────────────────────────────────────────────
  _handleGesture(gesture, lms, handIdx) {
    const canvas  = this.editor.renderer.domElement;
    const pos     = wristPos(lms, canvas.width, canvas.height);
    const prev    = this.prevGesture[handIdx];

    switch (gesture) {
      case 'OPEN_PALM': {
        this._setHUDGesture('Open palm', '🖐');
        this._clearDeleteTimer();
        // Move cursor: synthesise a mousemove so raycasting works
        this._fireMouse('mousemove', pos.x, pos.y);
        // If we were grabbing, drag the object
        if (this.grabbing[handIdx] && this.editor.selectedObject) {
          this.editor._onClick({ clientX: pos.x, clientY: pos.y });
        }
        break;
      }

      case 'PINCH': {
        this._setHUDGesture('Pinch — grab', '🤏');
        this._clearDeleteTimer();
        if (!this.grabbing[handIdx]) {
          // Transition into grab: click to select whatever is under cursor
          this.grabbing[handIdx] = true;
          this.grabStart[handIdx] = pos;
          this._fireMouse('click', pos.x, pos.y);
          this._showCursorRing(pos, '#4ECDC4');
        } else {
          // Dragging: move selected object
          if (this.editor.selectedObject) {
            this._moveDelta(pos, handIdx);
          }
        }
        break;
      }

      case 'FIST': {
        this._setHUDGesture('Fist — rotate', '✊');
        this._clearDeleteTimer();
        if (prev !== 'FIST') {
          this.fistYaw[handIdx] = pos.x;
        } else if (this.editor.selectedObject && this.fistYaw[handIdx] !== null) {
          const delta = (pos.x - this.fistYaw[handIdx]) / canvas.width * Math.PI;
          this.fistYaw[handIdx] = pos.x;
          this.editor.rotateObject(this.editor.selectedObject, delta);
        }
        this.grabbing[handIdx] = false;
        break;
      }

      case 'THUMBS_UP': {
        this._setHUDGesture('Thumbs up — create', '👍');
        this._clearDeleteTimer();
        if (prev !== 'THUMBS_UP') {
          // Only create once on gesture transition
          this.editor.addCube();
          this._pulse('#4ECDC4');
        }
        this.grabbing[handIdx] = false;
        break;
      }

      case 'VICTORY': {
        this._setHUDGesture('Victory — delete (hold 1s)', '✌️');
        this.grabbing[handIdx] = false;
        if (prev !== 'VICTORY') {
          this._startDeleteTimer();
        }
        break;
      }

      default: {
        this._setHUDGesture('—', '🖐');
        this._clearDeleteTimer();
        this.grabbing[handIdx] = false;
        break;
      }
    }

    this.lastWrist[handIdx]  = pos;
    this.prevGesture[handIdx] = gesture;
  }

  // ── Two-hand scale ─────────────────────────────────────────────────────
  _handleTwoHandScale(lms0, lms1) {
    const canvas = this.editor.renderer.domElement;
    const p0 = wristPos(lms0, canvas.width, canvas.height);
    const p1 = wristPos(lms1, canvas.width, canvas.height);
    const d  = Math.hypot(p0.x - p1.x, p0.y - p1.y);

    if (this.twoHandScale === null) {
      this.twoHandScale = d;
      return;
    }

    const ratio = d / this.twoHandScale;
    this.twoHandScale = d;

    if (this.editor.selectedObject && Math.abs(ratio - 1) > 0.005) {
      this.editor.scaleObject(this.editor.selectedObject, ratio);
    }
  }

  // ── Move object based on wrist delta ──────────────────────────────────
  _moveDelta(pos, handIdx) {
    const prev = this.lastWrist[handIdx];
    if (!prev) return;
    const canvas = this.editor.renderer.domElement;

    const dx = (pos.x - prev.x) / canvas.width  * 10;
    const dz = (pos.y - prev.y) / canvas.height * 10;

    const id  = this.editor.selectedObject;
    const obj = this.editor.objects.get(id);
    if (!obj) return;

    const p = obj.transform.position.value;
    this.editor.moveObject(id, { x: p.x + dx, y: p.y, z: p.z + dz });
  }

  // ── Delete with hold confirmation ──────────────────────────────────────
  _startDeleteTimer() {
    if (this.deleteTimer) return;
    let progress = 0;
    const total  = 1000; // ms
    const step   = 50;

    this.deleteTimer = setInterval(() => {
      progress += step;
      const pct = Math.min(progress / total, 1);
      this.hud.querySelector('#gh-gesture').textContent = `✌️ Deleting… ${Math.round(pct*100)}%`;

      if (pct >= 1) {
        this._clearDeleteTimer();
        this.editor.deleteSelected();
        this._pulse('#fc8181');
        this._setHUDGesture('Deleted!', '🗑');
      }
    }, step);
  }

  _clearDeleteTimer() {
    if (this.deleteTimer) { clearInterval(this.deleteTimer); this.deleteTimer = null; }
  }

  _resetGrabState() {
    this.grabbing   = [false, false];
    this.grabStart  = [null, null];
    this.fistYaw    = [null, null];
    this.twoHandScale = null;
    this._clearDeleteTimer();
  }

  // ── Synthetic mouse events (so the editor's raycaster works) ──────────
  _fireMouse(type, x, y) {
    const canvas = this.editor.renderer.domElement;
    canvas.dispatchEvent(new MouseEvent(type, {
      clientX: x, clientY: y, bubbles: true,
      view: window, cancelable: true,
    }));
  }

  // ── Visual feedback ────────────────────────────────────────────────────
  _showCursorRing(pos, color) {
    let ring = document.getElementById('gesture-cursor-ring');
    if (!ring) {
      ring = document.createElement('div');
      ring.id = 'gesture-cursor-ring';
      ring.style.cssText = 'position:fixed;pointer-events:none;z-index:998;border-radius:50%;border:2px solid;transition:transform .1s,opacity .2s;width:28px;height:28px;margin:-14px 0 0 -14px';
      document.body.appendChild(ring);
    }
    ring.style.left    = pos.x + 'px';
    ring.style.top     = pos.y + 'px';
    ring.style.borderColor = color;
    ring.style.opacity = '1';
    ring.style.transform = 'scale(1.3)';
    setTimeout(() => { ring.style.transform = 'scale(1)'; }, 150);
  }

  _pulse(color) {
    const ring = document.getElementById('gesture-cursor-ring');
    if (!ring) return;
    ring.style.borderColor = color;
    ring.style.transform   = 'scale(2.5)';
    ring.style.opacity     = '0';
    setTimeout(() => {
      ring.style.transform = 'scale(1)';
      ring.style.opacity   = '1';
      ring.style.borderColor = '#4ECDC4';
    }, 400);
  }

  // ── HUD preview canvas skeleton ────────────────────────────────────────
  _drawPreview(results) {
    const ctx = this.hudCtx;
    ctx.clearRect(0, 0, 80, 60);
    if (!results.multiHandLandmarks?.length) return;

    const CONNECTIONS = [
      [0,1],[1,2],[2,3],[3,4],
      [0,5],[5,6],[6,7],[7,8],
      [5,9],[9,10],[10,11],[11,12],
      [9,13],[13,14],[14,15],[15,16],
      [13,17],[17,18],[18,19],[19,20],[0,17],
    ];

    results.multiHandLandmarks.forEach(lms => {
      ctx.strokeStyle = '#4ECDC4';
      ctx.lineWidth   = 1;

      CONNECTIONS.forEach(([a, b]) => {
        const ax = (1 - lms[a].x) * 80;
        const ay =      lms[a].y  * 60;
        const bx = (1 - lms[b].x) * 80;
        const by =      lms[b].y  * 60;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      });

      lms.forEach(lm => {
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc((1 - lm.x) * 80, lm.y * 60, 1.5, 0, Math.PI * 2);
        ctx.fill();
      });
    });
  }
}
