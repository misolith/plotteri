// Jarven 3D-syvyysnakyma. Ladataan dynaamisesti vasta kun kayttaja avaa nakyman;
// three.js haetaan cdnjs:sta vasta talloin. Tukee vapaan orbit-kameran lisaksi
// venetta seuraavaa eteenpain katsovaa kameraa (updateBoat + setAnalysis).

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
  opts = opts || {};
  var THREE = await loadThree();

  // ---------- DOM ----------
  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2000;background:#05141c;display:flex;flex-direction:column;';
  overlay.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:calc(10px + env(safe-area-inset-top)) 14px 10px;color:#d8e6ea;font-size:14px;">' +
    '<div style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"><strong data-role="title"></strong>' +
    '<span style="color:#6f8e99;margin-left:8px;" data-role="subtitle"></span></div>' +
    '<button data-act="close" style="flex:0 0 auto;background:#163244;color:#d8e6ea;border:1px solid #234a5f;border-radius:8px;padding:8px 14px;font-size:14px;">Sulje</button>' +
    '</div>' +
    '<div data-role="canvas-wrap" style="flex:1;min-height:0;position:relative;"></div>' +
    '<div style="display:flex;align-items:center;gap:10px;padding:10px 14px calc(12px + env(safe-area-inset-bottom));color:#6f8e99;font-size:12px;">' +
    '<button data-act="follow" style="flex:0 0 auto;background:#163244;color:#d8e6ea;border:1px solid #234a5f;border-radius:8px;padding:7px 12px;font-size:12px;">Seuraa</button>' +
    '<span>Korostus</span>' +
    '<input data-act="ex" type="range" min="1" max="10" step="0.5" value="4" style="flex:1;min-width:0;accent-color:#e8a13c;">' +
    '<span data-role="ex-val" class="mono" style="color:#d8e6ea;">4×</span>' +
    '</div>';
  document.body.appendChild(overlay);
  overlay.querySelector('[data-role="title"]').textContent = opts.title || '3D-syvyysnäkymä';
  var subtitleEl = overlay.querySelector('[data-role="subtitle"]');
  var wrap = overlay.querySelector('[data-role="canvas-wrap"]');
  var exInput = overlay.querySelector('[data-act="ex"]');
  var exVal = overlay.querySelector('[data-role="ex-val"]');
  var followBtn = overlay.querySelector('[data-act="follow"]');

  // ---------- scene ----------
  var renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  wrap.appendChild(renderer.domElement);
  renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;touch-action:none;';

  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05141c);
  var camera = new THREE.PerspectiveCamera(55, 1, 1, 500000);
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  var sun = new THREE.DirectionalLight(0xffffff, 1.1);
  scene.add(sun);

  var group = new THREE.Group();
  scene.add(group);

  // extent-riippuva tila, taytetaan buildTerrain-kutsussa
  var a = null;
  var centerLat = 0, centerLon = 0, mPerLat = 111320, mPerLon = 1;
  var widthM = 1, heightM = 1, maxDepth = 1;
  var geo = null, mesh = null, mat = null, waterGeo = null, water = null;
  var exaggeration = 4;

  var mainMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  var waterMat = new THREE.MeshBasicMaterial({ color: 0x1769aa, transparent: true, opacity: 0.07, depthWrite: false });

  function applyExaggeration() {
    var posAttr = geo.attributes.position;
    for (var vy = 0; vy < a.ny; vy++) {
      for (var vx = 0; vx < a.nx; vx++) {
        var vi = vy * a.nx + vx;
        var gi = (a.ny - 1 - vy) * a.nx + vx;
        var d = a.mask[gi] ? a.depth[gi] : NaN;
        posAttr.setY(vi, isNaN(d) || d <= 0 ? 2 * exaggeration : -d * exaggeration);
      }
    }
    posAttr.needsUpdate = true;
    geo.computeVertexNormals();
  }

  function buildTerrain(analysisNext) {
    a = analysisNext;
    centerLat = (a.south + a.north) / 2;
    centerLon = (a.west + a.east) / 2;
    mPerLon = 111320 * Math.cos(centerLat * Math.PI / 180);
    widthM = (a.east - a.west) * mPerLon;
    heightM = (a.north - a.south) * mPerLat;
    maxDepth = 0;
    for (var i = 0; i < a.nx * a.ny; i++) {
      if (a.mask[i] && a.depth[i] > maxDepth) maxDepth = a.depth[i];
    }

    if (mesh) { group.remove(mesh); geo.dispose(); }
    if (water) { group.remove(water); waterGeo.dispose(); }

    geo = new THREE.PlaneGeometry(widthM, heightM, a.nx - 1, a.ny - 1);
    geo.rotateX(-Math.PI / 2);
    var colors = new Float32Array(a.nx * a.ny * 3);
    for (var vy = 0; vy < a.ny; vy++) {
      for (var vx = 0; vx < a.nx; vx++) {
        var vi = vy * a.nx + vx;
        var gi = (a.ny - 1 - vy) * a.nx + vx;
        var c = depthColor(a.mask[gi] ? a.depth[gi] : NaN, maxDepth);
        colors[vi * 3] = c[0];
        colors[vi * 3 + 1] = c[1];
        colors[vi * 3 + 2] = c[2];
      }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    mesh = new THREE.Mesh(geo, mainMat);
    group.add(mesh);

    waterGeo = new THREE.PlaneGeometry(widthM, heightM);
    waterGeo.rotateX(-Math.PI / 2);
    water = new THREE.Mesh(waterGeo, waterMat);
    water.position.y = 0.5;
    group.add(water);

    sun.position.set(-widthM, Math.max(widthM, heightM), heightM);
    applyExaggeration();
    updateSubtitle();
  }

  // Koordinaatisto rotateX(-PI/2):n jalkeen: +X = ita, -Z = pohjoinen, +Y = ylos.
  function toLocal(lat, lon) {
    return { x: (lon - centerLon) * mPerLon, z: -(lat - centerLat) * mPerLat };
  }

  function depthAtLatLon(lat, lon) {
    if (!a || lon < a.west || lon > a.east || lat < a.south || lat > a.north) return NaN;
    var gx = Math.min(a.nx - 1, Math.max(0, Math.floor((lon - a.west) / a.cellLon)));
    var gy = Math.min(a.ny - 1, Math.max(0, Math.floor((lat - a.south) / a.cellLat)));
    var idx = gy * a.nx + gx;
    return a.mask[idx] ? a.depth[idx] : NaN;
  }

  // ---------- vene ----------
  var boat = {
    hasFix: false,
    lat: 0, lon: 0,
    curX: 0, curZ: 0, curH: 0,
    tgtX: 0, tgtZ: 0, tgtH: 0
  };
  var markerGeo = new THREE.ConeGeometry(1, 3, 8);
  markerGeo.rotateX(Math.PI / 2);
  var markerMat = new THREE.MeshBasicMaterial({ color: 0xe8a13c });
  var marker = new THREE.Mesh(markerGeo, markerMat);
  marker.visible = false;
  scene.add(marker);

  function markerScale() {
    var ref = mode === 'follow' ? chaseDist * 0.05 : radius * 0.02;
    var s = Math.max(2.5, Math.min(16, ref));
    marker.scale.set(s, s, s);
  }

  function updateSubtitle() {
    var text = 'max ' + maxDepth.toFixed(1) + ' m';
    if (boat.hasFix) {
      var d = depthAtLatLon(boat.lat, boat.lon);
      if (!isNaN(d)) text += ' · veneen alla ~' + d.toFixed(1) + ' m';
    }
    subtitleEl.textContent = text;
  }

  // ---------- kamera ----------
  var mode = 'orbit';
  var userChoseMode = false;
  var target = new THREE.Vector3(0, 0, 0);
  var radius = 1, theta = Math.PI * 1.75, phi = 0.9;
  var chaseDist = 140;

  function setMode(next, byUser) {
    mode = next;
    if (byUser) userChoseMode = true;
    followBtn.style.background = mode === 'follow' ? '#e8a13c' : '#163244';
    followBtn.style.color = mode === 'follow' ? '#05141c' : '#d8e6ea';
    followBtn.style.borderColor = mode === 'follow' ? '#e8a13c' : '#234a5f';
  }

  function applyOrbitCamera() {
    phi = Math.max(0.12, Math.min(1.45, phi));
    radius = Math.max(Math.max(widthM, heightM) * 0.1, Math.min(Math.max(widthM, heightM) * 4, radius));
    camera.position.set(
      target.x + radius * Math.cos(phi) * Math.sin(theta),
      target.y + radius * Math.sin(phi),
      target.z + radius * Math.cos(phi) * Math.cos(theta)
    );
    camera.lookAt(target);
  }

  function applyFollowCamera() {
    var h = boat.curH * Math.PI / 180;
    var fx = Math.sin(h), fz = -Math.cos(h);
    var eyeY = Math.max(30, chaseDist * 0.75);
    camera.position.set(
      boat.curX - fx * chaseDist,
      eyeY,
      boat.curZ - fz * chaseDist
    );
    var lookY = -Math.min(maxDepth * exaggeration * 0.35, eyeY);
    camera.lookAt(new THREE.Vector3(
      boat.curX + fx * chaseDist * 1.2,
      lookY,
      boat.curZ + fz * chaseDist * 1.2
    ));
  }

  function syncOrbitFromCamera() {
    target.set(boat.hasFix ? boat.curX : 0, 0, boat.hasFix ? boat.curZ : 0);
    var off = camera.position.clone().sub(target);
    radius = Math.max(1, off.length());
    phi = Math.asin(Math.max(-1, Math.min(1, off.y / radius)));
    theta = Math.atan2(off.x, off.z);
  }

  // ---------- syotteet ----------
  var pointers = new Map();
  var lastPinch = 0;
  function onPointerDown(e) {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    renderer.domElement.setPointerCapture(e.pointerId);
    if (mode === 'follow') {
      syncOrbitFromCamera();
      setMode('orbit', true);
    }
  }
  function onPointerMove(e) {
    var p = pointers.get(e.pointerId);
    if (!p) return;
    if (pointers.size === 1) {
      theta -= (e.clientX - p.x) * 0.006;
      phi += (e.clientY - p.y) * 0.005;
      applyOrbitCamera();
    } else if (pointers.size === 2) {
      p.x = e.clientX; p.y = e.clientY;
      var pts = Array.from(pointers.values());
      var pinch = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (lastPinch > 0) {
        var f = lastPinch / pinch;
        if (mode === 'follow') chaseDist = Math.max(40, Math.min(600, chaseDist * f));
        else { radius *= f; applyOrbitCamera(); }
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
    var f = Math.pow(1.1, e.deltaY > 0 ? 1 : -1);
    if (mode === 'follow') chaseDist = Math.max(40, Math.min(600, chaseDist * f));
    else { radius *= f; applyOrbitCamera(); }
  }
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('pointercancel', onPointerUp);
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

  followBtn.addEventListener('click', function () {
    setMode(mode === 'follow' ? 'orbit' : 'follow', true);
    if (mode === 'orbit') syncOrbitFromCamera();
  });

  exInput.addEventListener('input', function () {
    exaggeration = parseFloat(exInput.value) || 4;
    exVal.textContent = exaggeration + '×';
    applyExaggeration();
  });

  function resize() {
    var w = wrap.clientWidth || 1;
    var h = wrap.clientHeight || 1;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);

  // ---------- paivitysrajapinta ----------
  var lastEdgeCallAt = 0;

  function updateBoat(lat, lon, headingDeg) {
    if (!isFinite(lat) || !isFinite(lon)) return;
    boat.lat = lat;
    boat.lon = lon;
    var fx = (lon - a.west) / (a.east - a.west);
    var fy = (lat - a.south) / (a.north - a.south);
    var inside = fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1;
    var local = toLocal(lat, lon);
    if (inside) {
      boat.tgtX = local.x;
      boat.tgtZ = local.z;
      if (headingDeg != null && isFinite(headingDeg)) boat.tgtH = headingDeg;
      if (!boat.hasFix) {
        boat.hasFix = true;
        boat.curX = local.x;
        boat.curZ = local.z;
        boat.curH = boat.tgtH;
        marker.visible = true;
        if (!userChoseMode) setMode('follow', false);
      }
      updateSubtitle();
    } else {
      marker.visible = false;
    }
    if (opts.onNearEdge && (fx < 0.15 || fx > 0.85 || fy < 0.15 || fy > 0.85)) {
      var now = Date.now();
      if (now - lastEdgeCallAt > 8000) {
        lastEdgeCallAt = now;
        opts.onNearEdge(lat, lon);
      }
    }
  }

  function setAnalysis(analysisNext) {
    if (!analysisNext || !analysisNext.hasData) return;
    buildTerrain(analysisNext);
    markerScale();
    if (boat.hasFix) {
      var local = toLocal(boat.lat, boat.lon);
      boat.curX = boat.tgtX = local.x;
      boat.curZ = boat.tgtZ = local.z;
    }
  }

  // ---------- silmukka ----------
  var running = true;
  function frame() {
    if (!running) return;
    if (boat.hasFix) {
      boat.curX += (boat.tgtX - boat.curX) * 0.08;
      boat.curZ += (boat.tgtZ - boat.curZ) * 0.08;
      var dh = ((boat.tgtH - boat.curH + 540) % 360) - 180;
      boat.curH += dh * 0.08;
      marker.position.set(boat.curX, 2, boat.curZ);
      marker.rotation.y = Math.PI - boat.curH * Math.PI / 180;
      markerScale();
      if (mode === 'follow') applyFollowCamera();
    }
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }

  function close() {
    running = false;
    window.removeEventListener('resize', resize);
    if (geo) geo.dispose();
    if (waterGeo) waterGeo.dispose();
    markerGeo.dispose();
    markerMat.dispose();
    mainMat.dispose();
    waterMat.dispose();
    renderer.dispose();
    overlay.remove();
    if (opts.onClose) opts.onClose();
  }
  overlay.querySelector('[data-act="close"]').addEventListener('click', close);

  buildTerrain(analysis);
  markerScale();
  radius = Math.max(widthM, heightM) * 1.15;
  setMode('orbit', false);
  resize();
  applyOrbitCamera();
  frame();

  return { close: close, updateBoat: updateBoat, setAnalysis: setAnalysis };
}
