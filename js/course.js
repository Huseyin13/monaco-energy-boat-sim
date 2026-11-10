import * as THREE from 'three';

// Courses. A course is an ordered list of gates; a gate is an invisible
// line between two buoys.
//
// Gate crossing: the boat's movement this frame is a segment (previous
// position -> current position). If it intersects the gate segment the
// gate is passed. Unlike a radius check this cannot be skipped at high
// speed.
//
// Ghost: the record run (or lap) is stored at 10 Hz and replayed as a
// translucent boat on later runs.
// Penalty: touching a buoy adds 5 s.
//
// Modes:
//   slalom    : straight line of offset gates, total time
//   endurance : closed lap inside Port Hercule ("Stadium")
//   sprint    : 250 m straight outside the harbour, average speed

export const COURSE_DEFS = {
  slalom: {
    name: 'Slalom',
    loop: false,
    spawn: { x: 0, z: 0, heading: 0 },
    gates: [
      { cx: 0,   cz: 20,  dirX: 0, dirZ: 1, w: 12 }, // start
      { cx: 12,  cz: 55,  dirX: 0, dirZ: 1, w: 10 },
      { cx: -12, cz: 90,  dirX: 0, dirZ: 1, w: 10 },
      { cx: 12,  cz: 125, dirX: 0, dirZ: 1, w: 10 },
      { cx: -12, cz: 160, dirX: 0, dirZ: 1, w: 10 },
      { cx: 0,   cz: 195, dirX: 0, dirZ: 1, w: 12 }, // finish
    ],
  },
  endurance: {
    name: 'Endurance: Stadium (Port Hercule)',
    loop: true, // gate 0 is start/finish
    spawn: { x: -30, z: 25, heading: Math.PI / 2 },
    // Counter-clockwise lap: north along Digue Rainier III, west past
    // Quai Louis II / YCM, south along Quai Albert 1er.
    gates: [
      { cx: 0,   cz: 25,  dirX: 1,  dirZ: 0,  w: 14 }, // start/finish (eastbound)
      { cx: 55,  cz: 60,  dirX: 0,  dirZ: 1,  w: 14 }, // turn north at the breakwater
      { cx: 62,  cz: 165, dirX: 0,  dirZ: 1,  w: 14 },
      { cx: 25,  cz: 235, dirX: -1, dirZ: 0,  w: 14 }, // off YCM, westbound
      { cx: -30, cz: 232, dirX: -1, dirZ: 0,  w: 14 },
      { cx: -62, cz: 160, dirX: 0,  dirZ: -1, w: 14 }, // along Quai Albert, southbound
      { cx: -55, cz: 60,  dirX: 0,  dirZ: -1, w: 14 },
    ],
  },
  sprint: {
    // Runs outside the harbour, east of the breakwater, heading north.
    name: 'Sprint: open sea (250 m)',
    loop: false,
    distance: 250,
    spawn: { x: 110, z: -10, heading: 0 },
    gates: [
      { cx: 110, cz: 30,  dirX: 0, dirZ: 1, w: 12 }, // start (flying start allowed)
      { cx: 110, cz: 280, dirX: 0, dirZ: 1, w: 12 }, // finish
    ],
  },
};

// Segment intersection: solve p + t*r = q + u*s; hit if t,u in [0,1].
function segmentsCross(px, pz, rx, rz, qx, qz, sx, sz) {
  const denom = rx * sz - rz * sx;
  if (Math.abs(denom) < 1e-9) return false; // parallel
  const dx = qx - px, dz = qz - pz;
  const t = (dx * sz - dz * sx) / denom;
  const u = (dx * rz - dz * rx) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

const COLOR = {
  active: 0x2ecc40,  // next gate
  future: 0xffc300,
  passed: 0x888888,
  hit:    0xff2222,  // buoy contact flash
};

const BUOY_HIT_R = 1.4;       // m, contact radius (buoy + hull margin)
const PENALTY_S = 5;          // s per buoy contact
const HIT_COOLDOWN = 3;       // s before the same buoy can penalise again
const REC_DT = 0.1;           // s, ghost recording interval (10 Hz)

function makeBuoy() {
  const mat = new THREE.MeshStandardMaterial({ color: COLOR.future, roughness: 0.5 });
  const buoy = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.6, 1.6, 10), mat);
  body.position.y = 0.6;
  const top = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), mat);
  top.position.y = 1.6;
  buoy.add(body, top);
  buoy.userData.mat = mat;
  buoy.userData.hitUntil = 0;
  buoy.userData.lastHit = -99;
  return buoy;
}

// Interpolate angles along the shortest arc (avoids a spin at 350°->10°).
function lerpAngle(a, b, t) {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

export class Course {
  constructor(scene, def) {
    this.def = def;
    this.group = new THREE.Group();
    scene.add(this.group);

    // Gate end points: centre ± perpendicular * half width
    this.gates = def.gates.map((g) => {
      const px = -g.dirZ, pz = g.dirX;
      const gate = {
        ...g,
        ax: g.cx + px * g.w / 2, az: g.cz + pz * g.w / 2,
        bx: g.cx - px * g.w / 2, bz: g.cz - pz * g.w / 2,
        buoyA: makeBuoy(), buoyB: makeBuoy(),
      };
      gate.buoyA.position.set(gate.ax, 0, gate.az);
      gate.buoyB.position.set(gate.bx, 0, gate.bz);
      this.group.add(gate.buoyA, gate.buoyB);
      return gate;
    });
    this.buoys = this.gates.flatMap((g) => [g.buoyA, g.buoyB]);

    this.arrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 5, COLOR.active, 1.8, 1.0);
    this.group.add(this.arrow);

    // Records and ghost persist across resets
    this.bestTotal = null;
    this.bestLap = null;
    this.ghostPath = null; // [{t, x, z, h}, ...]
    this.reset();
  }

  setVisible(v) { this.group.visible = v; }

  reset() {
    this.gateIndex = 0;
    this.running = false;
    this.finished = false;
    this.startT = 0;
    this.lapStart = 0;
    this.laps = 0;
    this.lastLap = null;
    this.totalTime = null;
    this.lastX = null;
    this.lastZ = null;
    this.penaltyS = 0;
    this.lapPenalty = 0;
    this.rec = [];
    this.nextRecT = 0;
    this.recolor();
  }

  recolor() {
    this.gates.forEach((g, i) => {
      let c = COLOR.future;
      if (i === this.gateIndex && !this.finished) c = COLOR.active;
      else if (!this.def.loop && i < this.gateIndex) c = COLOR.passed;
      g.buoyA.userData.mat.color.setHex(c);
      g.buoyB.userData.mat.color.setHex(c);
    });
    const g = this.gates[this.gateIndex];
    this.arrow.visible = !this.finished;
    if (g) {
      this.arrow.position.set(g.cx, 4, g.cz);
      this.arrow.setDirection(new THREE.Vector3(g.dirX, 0, g.dirZ));
    }
  }

  checkBuoyHits(x, z, time) {
    let restored = false;
    for (const b of this.buoys) {
      const u = b.userData;
      if (u.hitUntil && time > u.hitUntil) { u.hitUntil = 0; restored = true; }
      const d2 = (b.position.x - x) ** 2 + (b.position.z - z) ** 2;
      if (d2 < BUOY_HIT_R * BUOY_HIT_R && time - u.lastHit > HIT_COOLDOWN) {
        u.lastHit = time;
        u.hitUntil = time + 1.2;
        if (this.running && !this.finished) {
          this.penaltyS += PENALTY_S;
          this.lapPenalty += PENALTY_S;
        }
      }
    }
    if (restored) this.recolor();
    // Apply the red flash after recolor so it is not overwritten.
    for (const b of this.buoys) {
      if (b.userData.hitUntil > time) b.userData.mat.color.setHex(COLOR.hit);
    }
  }

  update(x, z, heading, time) {
    this.checkBuoyHits(x, z, time);

    // Ghost recording, time relative to run start (or lap start)
    if (this.running && !this.finished && time >= this.nextRecT) {
      const base = this.def.loop ? this.lapStart : this.startT;
      this.rec.push({ t: time - base, x, z, h: heading });
      this.nextRecT = time + REC_DT;
    }

    if (!this.finished && this.lastX !== null) {
      const g = this.gates[this.gateIndex];
      const mx = x - this.lastX, mz = z - this.lastZ;
      const crossed = segmentsCross(this.lastX, this.lastZ, mx, mz,
        g.ax, g.az, g.bx - g.ax, g.bz - g.az);
      const rightWay = mx * g.dirX + mz * g.dirZ > 0;
      if (crossed && rightWay) this.onGate(time);
    }
    this.lastX = x; this.lastZ = z;
  }

  onGate(time) {
    const d = this.def;
    if (!this.running) {
      // Start gate: start the clock and a fresh ghost recording
      this.running = true;
      this.startT = time;
      this.lapStart = time;
      this.gateIndex = 1;
      this.rec = [];
      this.nextRecT = time;
      this.lapPenalty = 0;
    } else if (d.loop && this.gateIndex === 0) {
      // Lap complete (penalties included)
      this.laps++;
      this.lastLap = time - this.lapStart + this.lapPenalty;
      if (this.bestLap === null || this.lastLap < this.bestLap) {
        this.bestLap = this.lastLap;
        this.ghostPath = this.rec;
      }
      this.lapStart = time;
      this.gateIndex = 1;
      this.rec = [];
      this.nextRecT = time;
      this.lapPenalty = 0;
    } else {
      this.gateIndex++;
      if (!d.loop && this.gateIndex >= this.gates.length) {
        this.finished = true;
        this.totalTime = time - this.startT + this.penaltyS;
        if (this.bestTotal === null || this.totalTime < this.bestTotal) {
          this.bestTotal = this.totalTime;
          this.ghostPath = this.rec;
        }
      } else if (d.loop) {
        this.gateIndex %= this.gates.length;
      }
    }
    this.recolor();
  }

  // Current ghost pose, or null when there is nothing to replay.
  ghostPose(time) {
    const path = this.ghostPath;
    if (!path || path.length < 2 || !this.running || this.finished) return null;
    const base = this.def.loop ? this.lapStart : this.startT;
    const dur = path[path.length - 1].t;
    let t = time - base;
    if (this.def.loop) t %= dur;
    else t = Math.min(t, dur);
    let i = 1;
    while (i < path.length - 1 && path[i].t < t) i++;
    const a = path[i - 1], b = path[i];
    const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
    return {
      x: a.x + (b.x - a.x) * f,
      z: a.z + (b.z - a.z) * f,
      h: lerpAngle(a.h, b.h, f),
    };
  }

  hudLines(time, x, z) {
    const d = this.def;
    const L = [`<b>${d.name}</b>`];
    const fmt = (t) => t.toFixed(1) + ' s';

    if (this.finished) {
      L.push(`FINISHED: ${fmt(this.totalTime)}`);
      if (d.distance) {
        const kmh = (d.distance / this.totalTime) * 3.6;
        L.push(`Average: ${kmh.toFixed(1)} km/h`);
      }
      L.push('T: try again');
    } else if (this.running) {
      L.push(`Time: ${fmt(time - this.startT + this.penaltyS)}`);
      if (d.loop) {
        L.push(`Lap: ${this.laps} · This lap: ${fmt(time - this.lapStart + this.lapPenalty)}`);
        if (this.lastLap !== null) L.push(`Last lap: ${fmt(this.lastLap)}`);
      } else {
        L.push(`Gate: ${this.gateIndex}/${this.gates.length - 1}`);
      }
    } else {
      L.push('Cross the green gate to start');
    }

    if (this.penaltyS > 0) L.push(`Penalty: +${this.penaltyS} s`);

    const g = this.gates[this.gateIndex];
    if (g && !this.finished) {
      L.push(`To gate: ${Math.hypot(g.cx - x, g.cz - z).toFixed(0)} m`);
    }
    if (this.bestLap !== null) L.push(`Best lap: ${fmt(this.bestLap)}`);
    if (this.bestTotal !== null) {
      L.push(`Record: ${fmt(this.bestTotal)}` +
        (d.distance ? ` (${((d.distance / this.bestTotal) * 3.6).toFixed(1)} km/h)` : ''));
    }
    if (this.ghostPath) L.push('<i>Ghost: record run</i>');
    return L;
  }
}
