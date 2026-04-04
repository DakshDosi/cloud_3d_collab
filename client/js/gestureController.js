// client/js/gestureController.js
// Hand gesture control via MediaPipe Hands. Lazy-loaded on first use.

const HANDS_CDN  = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/hands.js';
const CAMERA_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils@0.3.1675466862/camera_utils.js';

const LM = {
  WRIST:0, THUMB_TIP:4, THUMB_IP:3,
  INDEX_TIP:8, INDEX_PIP:6,
  MIDDLE_TIP:12, MIDDLE_PIP:10,
  RING_TIP:16, RING_PIP:14,
  PINKY_TIP:20, PINKY_PIP:18,
};

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function classify(lms) {
  const pinch = dist(lms[LM.THUMB_TIP], lms[LM.INDEX_TIP]);
  if (pinch < 0.06) return 'PINCH';
  const thumbOut  = lms[LM.THUMB_TIP].x > lms[LM.THUMB_IP].x;
  const indexUp   = lms[LM.INDEX_TIP].y   < lms[LM.INDEX_PIP].y;
  const middleUp  = lms[LM.MIDDLE_TIP].y  < lms[LM.MIDDLE_PIP].y;
  const ringUp    = lms[LM.RING_TIP].y    < lms[LM.RING_PIP].y;
  const pinkyUp   = lms[LM.PINKY_TIP].y   < lms[LM.PINKY_PIP].y;
  if (!thumbOut && !indexUp && !middleUp && !ringUp && !pinkyUp) return 'FIST';
  if (thumbOut && indexUp && middleUp && !ringUp && !pinkyUp)    return 'VICTORY';
  if (thumbOut && !indexUp && !middleUp && !ringUp && !pinkyUp)  return 'THUMBS_UP';
  if (thumbOut && indexUp && middleUp && ringUp && pinkyUp)      return 'OPEN_PALM';
  return 'OTHER';
}

// Map MediaPipe [0,1] landmark coords → CSS viewport pixels
function lmToCSS(lm, canvasEl) {
  const r = canvasEl.getBoundingClientRect();
  return {
    x: (1 - lm.x) * r.width  + r.left,  // mirror X
    y:      lm.y  * r.height + r.top,
  };
}

export class GestureController {
  constructor(editor) {
    this.editor      = editor;
    this.active      = false;
    this.prevGesture = null;
    this.grabbing    = false;
    this.lastWrist   = null;
    this.fistStartX  = null;
    this.twoScale    = null;
    this.deleteTimer = null;
    this._buildHUD();
  }

  toggle() { this.active ? this.disable() : this.enable(); }

  async enable() {
    if (this.active) return;
    this.active = true;
    this.hud.style.display = 'flex';
    this._status('loading', 'Loading MediaPipe…');
    try {
      await this._loadScripts();
      await this._startCamera();
      this._status('on', 'Gestures active');
    } catch (e) {
      this._status('error', 'Camera denied');
      console.error('GestureController:', e);
    }
  }

  disable() {
    this.active = false;
    this.camera?.stop();
    this.videoEl?.remove();
    this.hud.style.display = 'none';
    this._clearDelete();
    this.grabbing = false;
  }

  _loadScripts() {
    return Promise.all([HANDS_CDN, CAMERA_CDN].map(src => new Promise((res, rej) => {
      if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    })));
  }

  async _startCamera() {
    this.videoEl = document.createElement('video');
    Object.assign(this.videoEl.style, {
      position: 'fixed', bottom: '90px', left: '16px',
      width: '140px', height: '105px', borderRadius: '8px',
      border: '1px solid #2d3748', objectFit: 'cover',
      zIndex: '499', transform: 'scaleX(-1)', opacity: '0.75',
      pointerEvents: 'none',
    });
    document.body.appendChild(this.videoEl);

    this.hands = new Hands({
      locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${f}`
    });
    this.hands.setOptions({ maxNumHands: 2, modelComplexity: 1, minDetectionConfidence: 0.75, minTrackingConfidence: 0.65 });
    this.hands.onResults(r => this._onResults(r));

    this.camera = new Camera(this.videoEl, {
      onFrame: async () => { if (this.active) await this.hands.send({ image: this.videoEl }); },
      width: 640, height: 480,
    });
    await this.camera.start();
  }

  _onResults(results) {
    if (!this.active) return;
    const lmsList = results.multiHandLandmarks || [];
    this._drawPreview(results);

    if (lmsList.length === 0) {
      this._setGesture('—', '🖐');
      this._clearDelete();
      this.grabbing = false;
      this.lastWrist = null;
      return;
    }

    // Two-hand scale
    if (lmsList.length === 2 && classify(lmsList[0]) === 'PINCH' && classify(lmsList[1]) === 'PINCH') {
      this._handleScale(lmsList[0], lmsList[1]);
      this._setGesture('Scale', '🤏🤏');
      return;
    }
    this.twoScale = null;

    // Single hand
    const lms     = lmsList[0];
    const gesture = classify(lms);
    const canvas  = this.editor.renderer.domElement;
    const wrist   = lmToCSS(lms[LM.WRIST], canvas);

    this._handleGesture(gesture, wrist, canvas);
    this.lastWrist   = wrist;
    this.prevGesture = gesture;
  }

  _handleGesture(gesture, wrist, canvas) {
    switch (gesture) {
      case 'OPEN_PALM':
        this._setGesture('Move cursor', '🖐');
        this._clearDelete();
        this.grabbing = false;
        // Fire a real mousemove so hover states update
        canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: wrist.x, clientY: wrist.y, bubbles: true }));
        break;

      case 'PINCH':
        this._setGesture('Grab', '🤏');
        this._clearDelete();
        if (!this.grabbing) {
          // Select on first pinch
          this.grabbing = true;
          canvas.dispatchEvent(new MouseEvent('click', { clientX: wrist.x, clientY: wrist.y, bubbles: true, cancelable: true, view: window }));
        } else if (this.editor.selectedObject && this.lastWrist) {
          // Drag: convert pixel delta → world delta
          const r  = canvas.getBoundingClientRect();
          const dx = (wrist.x - this.lastWrist.x) / r.width  * 10;
          const dz = (wrist.y - this.lastWrist.y) / r.height * 10;
          const obj = this.editor.objects.get(this.editor.selectedObject);
          if (obj) {
            const p = obj.transform.position.value;
            this.editor.moveObject(this.editor.selectedObject, { x: p.x + dx, y: p.y, z: p.z + dz });
          }
        }
        break;

      case 'FIST':
        this._setGesture('Rotate', '✊');
        this._clearDelete();
        this.grabbing = false;
        if (this.prevGesture !== 'FIST') { this.fistStartX = wrist.x; }
        else if (this.editor.selectedObject && this.lastWrist) {
          const r     = canvas.getBoundingClientRect();
          const delta = (wrist.x - this.lastWrist.x) / r.width * Math.PI;
          this.editor.rotateObject(this.editor.selectedObject, delta);
        }
        break;

      case 'THUMBS_UP':
        this._setGesture('Add cube', '👍');
        this._clearDelete();
        this.grabbing = false;
        if (this.prevGesture !== 'THUMBS_UP') {
          this.editor.addCube();
          this._pulse();
        }
        break;

      case 'VICTORY':
        this._setGesture('Delete (hold 1s)', '✌️');
        this.grabbing = false;
        if (this.prevGesture !== 'VICTORY') this._startDelete();
        break;

      default:
        this._setGesture('—', '✋');
        this._clearDelete();
        this.grabbing = false;
    }
  }

  _handleScale(lms0, lms1) {
    const canvas = this.editor.renderer.domElement;
    const p0 = lmToCSS(lms0[LM.WRIST], canvas);
    const p1 = lmToCSS(lms1[LM.WRIST], canvas);
    const d  = Math.hypot(p0.x - p1.x, p0.y - p1.y);
    if (this.twoScale === null) { this.twoScale = d; return; }
    const ratio = d / this.twoScale;
    this.twoScale = d;
    if (this.editor.selectedObject && Math.abs(ratio - 1) > 0.004) {
      this.editor.scaleObject(this.editor.selectedObject, ratio);
    }
  }

  _startDelete() {
    if (this.deleteTimer) return;
    let elapsed = 0;
    this.deleteTimer = setInterval(() => {
      elapsed += 50;
      const pct = Math.min(elapsed / 1000, 1);
      this._setGesture(`Delete ${Math.round(pct * 100)}%`, '✌️');
      if (pct >= 1) {
        this._clearDelete();
        this.editor.deleteSelected();
        this._pulse();
      }
    }, 50);
  }

  _clearDelete() { clearInterval(this.deleteTimer); this.deleteTimer = null; }

  _pulse() {
    const ring = document.getElementById('gest-ring');
    if (!ring) return;
    ring.style.transform = 'scale(2.5)'; ring.style.opacity = '0';
    setTimeout(() => { ring.style.transform = 'scale(1)'; ring.style.opacity = '1'; }, 400);
  }

  // ── HUD ────────────────────────────────────────────────────────────────────
  _buildHUD() {
    const hud = document.createElement('div');
    hud.id = 'gest-hud';
    Object.assign(hud.style, {
      display: 'none', position: 'fixed', bottom: '20px', left: '50%',
      transform: 'translateX(-50%)', zIndex: '500', gap: '12px',
      background: 'rgba(15,17,23,.9)', border: '1px solid #2d3748',
      borderRadius: '12px', padding: '10px 18px', alignItems: 'center',
      fontFamily: 'system-ui,sans-serif', fontSize: '13px', color: '#e2e8f0',
      backdropFilter: 'blur(10px)', minWidth: '300px',
    });
    hud.innerHTML = `
      <div id="gest-dot" style="width:8px;height:8px;border-radius:50%;background:#718096;flex-shrink:0"></div>
      <span id="gest-status" style="flex:1;color:#a0aec0">Initialising…</span>
      <span id="gest-name" style="font-weight:600;color:#4ECDC4;min-width:120px;text-align:right"></span>
      <div style="position:relative;width:72px;height:54px;border-radius:6px;overflow:hidden;border:1px solid #2d3748;background:#0f1117;flex-shrink:0">
        <canvas id="gest-canvas" width="72" height="54" style="width:100%;height:100%"></canvas>
      </div>
      <button id="gest-off" style="background:rgba(255,255,255,.07);border:none;border-radius:6px;color:#a0aec0;padding:4px 8px;cursor:pointer">Off</button>
    `;
    document.body.appendChild(hud);
    this.hud = hud;
    this.previewCtx = hud.querySelector('#gest-canvas').getContext('2d');
    hud.querySelector('#gest-off').addEventListener('click', () => this.disable());

    // Cursor ring
    const ring = document.createElement('div');
    ring.id = 'gest-ring';
    Object.assign(ring.style, {
      position: 'fixed', width: '28px', height: '28px', borderRadius: '50%',
      border: '2px solid #4ECDC4', pointerEvents: 'none', zIndex: '998',
      transform: 'translate(-50%,-50%)', transition: 'transform .15s, opacity .3s',
      display: 'none',
    });
    document.body.appendChild(ring);
    this.ring = ring;
  }

  _status(state, text) {
    this.hud.style.display = 'flex';
    this.hud.querySelector('#gest-status').textContent = text;
    this.hud.querySelector('#gest-dot').style.background =
      state === 'on' ? '#4ECDC4' : state === 'loading' ? '#F6AD55' : '#fc8181';
  }

  _setGesture(name, emoji) {
    this.hud.querySelector('#gest-name').textContent = `${emoji} ${name}`;
  }

  _drawPreview(results) {
    const ctx = this.previewCtx;
    ctx.clearRect(0, 0, 72, 54);
    const CONN = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
    (results.multiHandLandmarks || []).forEach(lms => {
      ctx.strokeStyle = '#4ECDC4'; ctx.lineWidth = 1;
      CONN.forEach(([a, b]) => {
        ctx.beginPath();
        ctx.moveTo((1 - lms[a].x) * 72, lms[a].y * 54);
        ctx.lineTo((1 - lms[b].x) * 72, lms[b].y * 54);
        ctx.stroke();
      });
      lms.forEach(lm => {
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc((1 - lm.x) * 72, lm.y * 54, 1.5, 0, Math.PI * 2);
        ctx.fill();
      });
    });
  }
}