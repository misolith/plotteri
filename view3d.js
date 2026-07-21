// Jarven 3D-syvyysnakyma. Ladataan dynaamisesti vasta kun kayttaja avaa nakyman;
// three.js haetaan cdnjs:sta vasta talloin.

var THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.172.0/three.module.min.js';
var threePromise = null;

function loadThree() {
  if (!threePromise) threePromise = import(THREE_URL);
  return threePromise;
}

function depthColor(d, maxD) {
  if (isNaN(d) || d <= 0) return [0.045, 0.1, 0.13];
  var t = Math.min(1, d / Math.max(1, maxD));
  var stops = [
    [0.18, 0.83, 0.75],
    [0.09, 0.41, 0.67],
    [0.03, 0.12, 0.35]
  ];
  var pos = t * (stops.length - 1);
  var i = Math.min(stops.length - 2, Math.floor(pos));
  var f = pos - i;
  return [
    stops[i][0] + (stops[i + 1][0] - stops[i][0]) * f,
    stops[i][1] + (stops[i + 1][1] - stops[i][1]) * f,
    stops[i][2] + (stops[i + 1][2] - stops[i][2]) * f
  ];
}

export async function openBathy3d(analysis, opts) {
  if (!analysis || !analysis.hasData) throw new Error('no analysis data');
  var THREE = await loadThree();

  var nx = analysis.nx, ny = analysis.ny;
  var midLat = (analysis.south + analysis.north) / 2;
  var mPerLat = 111320;
  var mPerLon = 111320 * Math.cos(midLat * Math.PI / 180);
  var widthM = (analysis.east - analysis.west) * mPerLon;
  var heightM = (analysis.north - analysis.south) * mPerLat;

  var maxDepth = 0;
  for (var i = 0; i < nx * ny; i++) {
    if (analysis.mask[i] && analysis.depth[i] > maxDepth) maxDepth = analysis.depth[i];
  }

  // ---------- DOM ----------
  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2000;background:#05141c;display:flex;flex-direction:column;';
  overlay.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:calc(10px + env(safe-area-inset-top)) 14px 10px;color:#d8e6ea;font-size:14px;">' +
    '<div><strong data-role="title"></strong>' +
    '<span style="color:#6f8e99;margin-left:8px;" data-role="subtitle"></span></div>' +
    '<button data-act="close" style="background:#163244;color:#d8e6ea;border:1px solid #234a5f;border-radius:8px;padding:8px 14px;font-size:14px;">Sulje</button>' +
    '</div>' +
    '<div data-role="canvas-wrap" style="flex:1;min-height:0;position:relative;"></div>' +
    '<div style="display:flex;align-items:center;gap:10px;padding:10px 14px calc(12px + env(safe-area-inset-bottom));color:#6f8e99;font-size:12px;">' +
    '<span>Korostus</span>' +
    '<input data-act="ex" type="range" min="1" max="10" step="0.5" value="4" style="flex:1;accent-color:#e8a13c;">' +
    '<span data-role="ex-val" class="mono" style="color:#d8e6ea;">4×</span>' +
    '</div>';
  document.body.appendChild(overlay);
  overlay.querySelector('[data-role="title"]').textContent = opts && opts.title ? opts.title : '3D-syvyysnäkymä';
  overlay.querySelector('[data-role="subtitle"]').textContent = 'max ' + maxDepth.toFixed(1) + ' m';
  var wrap = overlay.querySelector('[data-role="canvas-wrap"]');
  var exInput = overlay.querySelector('[data-act="ex"]');
  var exVal = overlay.querySelector('[data-role="ex-val"]');

  // ---------- scene ----------
  var renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  wrap.appendChild(renderer.domElement);
  renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;touch-action:none;';

  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05141c);
  var camera = new THREE.PerspectiveCamera(55, 1, 1, widthM * 10);
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  var sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(-widthM, Math.max(widthM, heightM), heightM);
  scene.add(sun);

  var group = new THREE.Group();
  group.rotation.x = -Math.PI / 2;
  scene.add(group);

  var geo = new THREE.PlaneGeometry(widthM, heightM, nx - 1, ny - 1);
  var posAttr = geo.attributes.position;
  var colors = new Float32Array(posAttr.count * 3);
  for (var vy = 0; vy < ny; vy++) {
    for (var vx = 0; vx < nx; vx++) {
      var vi = vy * nx + vx;
      var gi = (ny - 1 - vy) * nx + vx;
      var c = depthColor(analysis.mask[gi] ? analysis.depth[gi] : NaN, maxDepth);
      colors[vi * 3] = c[0];
      colors[vi * 3 + 1] = c[1];
      colors[vi * 3 + 2] = c[2];
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  var mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  var mesh = new THREE.Mesh(geo, mat);
  group.add(mesh);

  var waterGeo = new THREE.PlaneGeometry(widthM, heightM);
  var waterMat = new THREE.MeshBasicMaterial({ color: 0x1769aa, transparent: true, opacity: 0.07, depthWrite: false });
  var water = new THREE.Mesh(waterGeo, waterMat);
  water.position.z = 0.5;
  group.add(water);

  function applyExaggeration(ex) {
    for (var vy2 = 0; vy2 < ny; vy2++) {
      for (var vx2 = 0; vx2 < nx; vx2++) {
        var vi2 = vy2 * nx + vx2;
        var gi2 = (ny - 1 - vy2) * nx + vx2;
        var d = analysis.mask[gi2] ? analysis.depth[gi2] : NaN;
        posAttr.setZ(vi2, isNaN(d) || d <= 0 ? 2 * ex : -d * ex);
      }
    }
    posAttr.needsUpdate = true;
    geo.computeVertexNormals();
  }
  applyExaggeration(4);

  // ---------- orbit ----------
  var target = new THREE.Vector3(0, -maxDepth * 2, 0);
  var radius = Math.max(widthM, heightM) * 1.15;
  var theta = Math.PI * 1.75;
  var phi = 0.9;
  var minR = Math.max(widthM, heightM) * 0.15;
  var maxR = Math.max(widthM, heightM) * 4;

  function applyCamera() {
    phi = Math.max(0.12, Math.min(1.45, phi));
    radius = Math.max(minR, Math.min(maxR, radius));
    camera.position.set(
      target.x + radius * Math.cos(phi) * Math.sin(theta),
      target.y + radius * Math.sin(phi),
      target.z + radius * Math.cos(phi) * Math.cos(theta)
    );
    camera.lookAt(target);
  }

  var pointers = new Map();
  var lastPinch = 0;
  function onPointerDown(e) {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    renderer.domElement.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e) {
    var p = pointers.get(e.pointerId);
    if (!p) return;
    if (pointers.size === 1) {
      theta -= (e.clientX - p.x) * 0.006;
      phi += (e.clientY - p.y) * 0.005;
      applyCamera();
    } else if (pointers.size === 2) {
      p.x = e.clientX; p.y = e.clientY;
      var pts = Array.from(pointers.values());
      var pinch = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (lastPinch > 0) {
        radius *= lastPinch / pinch;
        applyCamera();
      }
      lastPinch = pinch;
    }
    p.x = e.clientX; p.y = e.clientY;
  }
  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) lastPinch = 0;
  }
  function onWheel(e) {
    e.preventDefault();
    radius *= Math.pow(1.1, e.deltaY > 0 ? 1 : -1);
    applyCamera();
  }
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('pointercancel', onPointerUp);
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

  exInput.addEventListener('input', function () {
    var ex = parseFloat(exInput.value) || 4;
    exVal.textContent = ex + '×';
    applyExaggeration(ex);
  });

  function resize() {
    var w = wrap.clientWidth || 1;
    var h = wrap.clientHeight || 1;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);

  var running = true;
  function frame() {
    if (!running) return;
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }

  function close() {
    running = false;
    window.removeEventListener('resize', resize);
    geo.dispose();
    waterGeo.dispose();
    mat.dispose();
    waterMat.dispose();
    renderer.dispose();
    overlay.remove();
  }
  overlay.querySelector('[data-act="close"]').addEventListener('click', close);

  resize();
  applyCamera();
  frame();
  return { close: close };
}
