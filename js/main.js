import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { createWater } from './water.js';
import { createBoat } from './boat.js';
import { createEnvironment, COLLIDERS } from './environment.js';
import { createWake } from './wake.js';
import { Course, COURSE_DEFS } from './course.js';
import { Telemetry } from './telemetry.js';
import { sparkline, lineChart, trackMap, SERIES } from './charts.js';
import { DashboardLink } from './dashboard_link.js';

// Scene setup and main loop.

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
// The Sky shader outputs physical radiance; ACES maps it to screen range.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.65;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xbcdcee, 120, 380); // colour follows the sun

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1, 3000
);

const sky = new Sky();
sky.scale.setScalar(2000);
scene.add(sky);
const skyU = sky.material.uniforms;
skyU.turbidity.value = 6;
skyU.rayleigh.value = 1.6;
skyU.mieCoefficient.value = 0.004;
skyU.mieDirectionalG.value = 0.8;

const sun = new THREE.DirectionalLight(0xffffff, 1.6);
scene.add(sun);
const ambient = new THREE.AmbientLight(0xbfd9e8, 0.5);
scene.add(ambient);

// Time of day. Sun elevation drives both lighting and solar panel
// irradiance (W/m²). N advances one hour.
let dayHour = 12;
let sunIrradiance = 1000;
function updateSun() {
  const t = (dayHour - 6) / 12;                 // 06:00..18:00 -> 0..1
  const elev = Math.sin(Math.PI * t) * THREE.MathUtils.degToRad(65);
  const azim = THREE.MathUtils.degToRad(80 + t * 160); // east to west
  const dir = new THREE.Vector3().setFromSphericalCoords(1, Math.PI / 2 - elev, azim);

  skyU.sunPosition.value.copy(dir);
  sun.position.copy(dir).multiplyScalar(200);

  const s = Math.max(0, Math.sin(elev));
  sun.intensity = 0.4 + 2.2 * s;
  ambient.intensity = 0.25 + 0.5 * s;
  // Low sun shifts the horizon and fog toward orange
  scene.fog.color.lerpColors(
    new THREE.Color(0xe8b98a), new THREE.Color(0xbcdcee), Math.min(1, s * 1.5));

  // Irradiance is not linear in elevation (air mass)
  sunIrradiance = 1000 * Math.pow(s, 1.2);
  boat.userData.setSunIrradiance(sunIrradiance);
}

const water = createWater(400, 128);
scene.add(water);

const boat = createBoat();
scene.add(boat);
updateSun(); // needs the boat for the solar source

createEnvironment(scene);
boat.userData.setColliders(COLLIDERS);
const wake = createWake(scene);

// Courses: all built once, only the active one is visible, records
// persist for the session. Keys 4/5/6.
const courses = {
  Digit4: new Course(scene, COURSE_DEFS.slalom),
  Digit5: new Course(scene, COURSE_DEFS.endurance),
  Digit6: new Course(scene, COURSE_DEFS.sprint),
};
Object.values(courses).forEach((c) => c.setVisible(false));
let course = null;

function selectCourse(code) {
  if (!courses[code]) return;
  if (course) course.setVisible(false);
  course = courses[code];
  course.reset();
  course.setVisible(true);
  const sp = course.def.spawn;
  boat.userData.teleport(sp.x, sp.z, sp.heading);
  telemetry.clear();
}

// Ghost boat: translucent catamaran replaying the record run.
function makeGhostMesh() {
  const mat = new THREE.MeshBasicMaterial({
    color: 0x35e0ff, transparent: true, opacity: 0.30, depthWrite: false,
  });
  const g = new THREE.Group();
  const hullL = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.55, 6.0), mat);
  hullL.position.set(1.15, 0.3, 0);
  const hullR = hullL.clone();
  hullR.position.x = -1.15;
  const deck = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.16, 3.2), mat);
  deck.position.y = 0.68;
  g.add(hullL, hullR, deck);
  g.visible = false;
  return g;
}
const ghost = makeGhostMesh();
scene.add(ghost);

// Wind: B cycles the strength, direction is randomised each time.
const WIND_LEVELS = [
  { label: 'Calm',   ms: 0 },
  { label: 'Light',  ms: 3.5 },
  { label: 'Strong', ms: 7.0 },
];
let windIdx = 0;
let windDir = 0; // direction the wind blows toward (rad)
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']; // +z = north, +x = east
function windLabel() {
  const s = boat.userData.state;
  if (WIND_LEVELS[windIdx].ms === 0) return 'Calm';
  const ms = Math.hypot(s.windX, s.windZ);
  // Wind is named by the direction it comes from
  const from = Math.atan2(s.windX, s.windZ) + Math.PI;
  const oct = Math.round(((from + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 4)) % 8;
  return `${WIND_LEVELS[windIdx].label} · ${ms.toFixed(1)} m/s ${COMPASS[oct]}`;
}
function cycleWind() {
  windIdx = (windIdx + 1) % WIND_LEVELS.length;
  windDir = Math.random() * 2 * Math.PI;
  const w = WIND_LEVELS[windIdx];
  boat.userData.setWind(Math.sin(windDir) * w.ms, Math.cos(windDir) * w.ms);
}

// Wind dial, fixed to the world (N up, E right). The blue arrow points
// where the wind blows; the orange marker is the boat's heading.
const windDial = document.getElementById('wind-dial');
const wctx = windDial.getContext('2d');
function drawWindDial() {
  const W = windDial.width, c = W / 2, R = c - 22;
  wctx.clearRect(0, 0, W, W);
  wctx.strokeStyle = 'rgba(232,244,255,0.30)';
  wctx.lineWidth = 2;
  wctx.beginPath();
  wctx.arc(c, c, R, 0, 2 * Math.PI);
  wctx.stroke();
  wctx.fillStyle = '#9fb8c8';
  wctx.font = 'bold 15px Consolas';
  wctx.textAlign = 'center';
  wctx.textBaseline = 'middle';
  wctx.fillText('N', c, c - R - 11);
  wctx.fillText('E', c + R + 11, c);
  wctx.fillText('S', c, c + R + 11);
  wctx.fillText('W', c - R - 11, c);
  // Arrow length scales with the current effective wind (incl. gusts)
  const st = boat.userData.state;
  const ms = Math.hypot(st.windX, st.windZ);
  if (ms > 0.3) {
    const ax = st.windX / ms, az = st.windZ / ms;
    const len = R * (0.35 + 0.5 * Math.min(1, ms / 8));
    const tx = c + ax * len, ty = c - az * len; // tip (downwind)
    const qx = c - ax * len, qy = c + az * len; // tail (upwind)
    wctx.strokeStyle = '#6fd3ff';
    wctx.fillStyle = '#6fd3ff';
    wctx.lineWidth = 3;
    wctx.beginPath();
    wctx.moveTo(qx, qy);
    wctx.lineTo(tx, ty);
    wctx.stroke();
    const ah = Math.atan2(ax, az);
    wctx.save();
    wctx.translate(tx, ty);
    wctx.rotate(ah);
    wctx.beginPath();
    wctx.moveTo(0, -9);
    wctx.lineTo(-6, 4);
    wctx.lineTo(6, 4);
    wctx.closePath();
    wctx.fill();
    wctx.restore();
  } else {
    wctx.fillStyle = 'rgba(232,244,255,0.5)';
    wctx.font = '13px Consolas';
    wctx.fillText('calm', c, c);
  }
  // Heading marker on the dial rim
  const h = boat.userData.state.heading;
  wctx.save();
  wctx.translate(c, c);
  wctx.rotate(h); // heading 0 = north = up
  wctx.fillStyle = '#ffc300';
  wctx.beginPath();
  wctx.moveTo(0, -R - 4);
  wctx.lineTo(-6, -R + 8);
  wctx.lineTo(6, -R + 8);
  wctx.closePath();
  wctx.fill();
  wctx.restore();
}

const telemetry = new Telemetry();

// Serial link to ground_station.py (Web Serial -> com0com). L toggles.
const dashboardLink = new DashboardLink();

// Keyboard input
const input = { forward: false, back: false, left: false, right: false };
const KEYMAP = {
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'back',    ArrowDown: 'back',
  KeyA: 'left',    ArrowLeft: 'left',
  KeyD: 'right',   ArrowRight: 'right',
};
addEventListener('keydown', (e) => {
  if (KEYMAP[e.code]) input[KEYMAP[e.code]] = true;
  if (e.code.startsWith('Digit')) {
    boat.userData.setSource(e.code); // 1/2/3: power source
    selectCourse(e.code);            // 4/5/6: course
  }
  if (e.code === 'KeyR') boat.userData.resetEnergy();
  if (e.code === 'KeyT' && course) {
    course.reset();
    const sp = course.def.spawn;
    boat.userData.teleport(sp.x, sp.z, sp.heading);
    telemetry.clear();
  }
  if (e.code === 'KeyG') {
    reportEl.classList.toggle('open');
    if (reportEl.classList.contains('open')) renderReport();
  }
  if (e.code === 'KeyE') downloadCSV();
  if (e.code === 'KeyL') dashboardLink.connect();
  if (e.code === 'KeyN') {
    dayHour = dayHour >= 18 ? 6 : dayHour + 1;
    updateSun();
  }
  if (e.code === 'KeyB') cycleWind();
});
addEventListener('keyup',   (e) => { if (KEYMAP[e.code]) input[KEYMAP[e.code]] = false; });

// Chase camera: eases toward a point behind and above the boat.
const camOffset = new THREE.Vector3(0, 6, -14);
function updateCamera(dt) {
  const target = camOffset.clone()
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), boat.userData.state.heading)
    .add(boat.position);
  camera.position.lerp(target, Math.min(1, dt * 3));
  camera.lookAt(boat.position.x, boat.position.y + 1.5, boat.position.z);
}

const hudSpeed = document.getElementById('hud-speed');
const hudKnots = document.getElementById('hud-knots');
const hudThrottle = document.getElementById('hud-throttle');
const hudThrust = document.getElementById('hud-thrust');
const hudDrag = document.getElementById('hud-drag');
const hudSource = document.getElementById('hud-source');
const hudPower = document.getElementById('hud-power');
const hudEnergy = document.getElementById('hud-energy');
const hudSun = document.getElementById('hud-sun');
const hudRpm = document.getElementById('hud-rpm');
const hudTemp = document.getElementById('hud-temp');
const hudWind = document.getElementById('hud-wind');
const hudRange = document.getElementById('hud-range');

// Range estimate: remaining % divided by a smoothed (EMA) drain rate.
// Works the same for every source; solar charging simply slows the
// drain and stretches the estimate.
let lastPct = null;
let drainEma = 0; // %/s
function updateRange(pct, dt) {
  if (lastPct !== null && dt > 0) {
    const d = (lastPct - pct) / dt;
    drainEma += (d - drainEma) * Math.min(1, dt / 5); // ~5 s time constant
  }
  lastPct = pct;
  if (drainEma > 1e-4) {
    const min = pct / drainEma / 60;
    hudRange.textContent = min > 999 ? '∞' : `~${min.toFixed(0)} min`;
  } else {
    hudRange.textContent = '∞';
  }
}

function updateHUD(dt) {
  const s = boat.userData.state;
  hudSpeed.textContent = (s.speed * 3.6).toFixed(1);
  hudKnots.textContent = (s.speed * 1.94384).toFixed(1);
  hudThrottle.textContent = Math.round(s.throttle * 100);
  hudThrust.textContent = Math.round(s.thrustN);
  hudDrag.textContent = Math.round(s.dragN);
  hudSource.textContent = s.sourceLabel;
  hudPower.textContent = (s.powerW / 1000).toFixed(1);
  hudEnergy.textContent = s.energyPct.toFixed(1);
  hudRpm.textContent = `${Math.round(s.rpm)} (${s.erpm} eRPM)`;
  hudTemp.textContent = `FET ${s.tempFet.toFixed(0)}° · Motor ${s.tempMotor.toFixed(0)}°`
    + (s.thermalDerate < 0.999 ? ` ⚠ derate ${Math.round(s.thermalDerate * 100)}%` : '');
  hudWind.textContent = windLabel();
  hudSun.textContent = `${String(dayHour).padStart(2, '0')}:00 · ${sunIrradiance.toFixed(0)} W/m²`;
  updateRange(s.energyPct, dt);
  drawWindDial();
}

// Live sparklines: last 60 s
const sparks = {
  speed: document.getElementById('spark-speed'),
  power: document.getElementById('spark-power'),
  energy: document.getElementById('spark-energy'),
};
const SPARK_N = 240; // 60 s at 4 Hz
function updateSparks() {
  const n = telemetry.t.length;
  const from = Math.max(0, n - SPARK_N);
  sparkline(sparks.speed, telemetry.v.slice(from), SERIES.speed);
  sparkline(sparks.power, telemetry.p.slice(from), SERIES.power);
  sparkline(sparks.energy, telemetry.e.slice(from), SERIES.energy);
}

// Run report
const reportEl = document.getElementById('report');
const hover = {}; // canvas id -> cursor x
const chartCfg = [
  ['ch-speed',  () => telemetry.v.map((v) => v * 3.6), SERIES.speed, ' km/h', (v) => v.toFixed(1), undefined],
  ['ch-power',  () => telemetry.p.map((p) => p / 1000), SERIES.power, ' kW', (v) => v.toFixed(1), undefined],
  ['ch-energy', () => telemetry.e, SERIES.energy, ' %', (v) => v.toFixed(0), [0, 100]],
];

function renderReport() {
  const st = telemetry.stats();
  document.getElementById('st-dur').textContent = st.durationS.toFixed(0) + ' s';
  document.getElementById('st-dist').textContent = (st.distM / 1000).toFixed(2) + ' km';
  document.getElementById('st-avg').textContent = st.avgKmh.toFixed(1) + ' km/h';
  document.getElementById('st-used').textContent = st.usedWh.toFixed(0) + ' Wh';
  document.getElementById('st-eff').textContent = st.whPerKm.toFixed(0);

  for (const [id, getVals, color, unit, fmt, range] of chartCfg) {
    lineChart(document.getElementById(id), {
      times: telemetry.t, values: getVals(), color, unit, fmt,
      yMin: range?.[0], yMax: range?.[1], hoverPx: hover[id],
    });
  }
  trackMap(document.getElementById('ch-track'), telemetry.x, telemetry.z, telemetry.v);
}

for (const [id] of chartCfg) {
  const cv = document.getElementById(id);
  cv.addEventListener('mousemove', (e) => {
    hover[id] = e.clientX - cv.getBoundingClientRect().left;
    renderReport();
  });
  cv.addEventListener('mouseleave', () => { hover[id] = null; renderReport(); });
}

function downloadCSV() {
  const blob = new Blob([telemetry.toCSV()], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `run_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

const racePanel = document.getElementById('race');
function updateRacePanel(time) {
  const s = boat.userData.state;
  racePanel.innerHTML = course
    ? course.hudLines(time, s.x, s.z).join('<br>')
    : '<b>Select a course</b><br>4: Slalom · 5: Endurance · 6: Sprint';
}

addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05); // clamp after tab switches
  const time = clock.elapsedTime;

  boat.userData.update(dt, time, input);
  water.userData.update(time, boat.position.x, boat.position.z);
  wake.update(dt, boat.userData.state);
  if (course) {
    const s = boat.userData.state;
    course.update(s.x, s.z, s.heading, time);
    const gp = course.ghostPose(time);
    if (gp) {
      ghost.visible = true;
      ghost.position.set(gp.x, 0.15, gp.z);
      ghost.rotation.y = gp.h;
    } else {
      ghost.visible = false;
    }
  } else {
    ghost.visible = false;
  }

  if (telemetry.sample(boat.userData.state, time, dt)) {
    updateSparks();
    if (reportEl.classList.contains('open')) renderReport();
  }

  updateCamera(dt);
  updateHUD(dt);
  updateRacePanel(time);
  dashboardLink.maybeSend(boat, time);

  renderer.render(scene, camera);
}
animate();
