// Boat dynamics: forces -> Newton's second law (a = F / m).
//
// Model:
//   Propeller : thrust/torque from shaft speed n and advance ratio J
//                 J = v/(n*D), T = Ct(J)*rho*n^2*D^4, Q = Cq(J)*rho*n^2*D^5
//               plus ventilation: full throttle from standstill draws
//               air and loses thrust.
//   Thermal   : FET and motor temperatures integrated from power; above
//               the limit the power cap is reduced (VESC-style derating).
//   Drag      : hull v^2 + wave-making (hump/planing via Froude number)
//               + head-sea added resistance + rudder drag.
//   Wind      : relative wind force with Ornstein-Uhlenbeck gusts.
//   Added mass: ~7% surge, ~60% sway.
//   Rudder    : sits in the propeller slipstream (can turn from rest
//               under throttle), stalls at large deflection.
//   Collision : shoreline AABBs; push out, damp normal velocity, apply
//               wall friction.

export const ENV = {
  rhoWater: 1025, // kg/m³, sea water
  rhoAir: 1.225,  // kg/m³
  g: 9.81,        // m/s²
};

// Dominant wave direction, same as WAVE[0].dir in water.js
const SEA_DIR = { x: 1.0 / Math.hypot(1.0, 0.3), z: 0.3 / Math.hypot(1.0, 0.3) };

function smoothstep(t) {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
}

export class BoatPhysics {
  constructor(params = {}) {
    // Energy Class scale defaults; all overridable.
    this.p = Object.assign({
      mass: 420,          // kg, boat + pilot
      Lwl: 6.0,           // m, waterline length (Froude)
      hullRadius: 1.8,    // m, collision radius
      addedMassF: 1.07,   // surge effective mass factor
      addedMassL: 1.6,    // sway effective mass factor
      // motor + propeller
      motorPowerMax: 20000, // W, electrical power cap
      motorEff: 0.90,       // electrical -> shaft
      propD: 0.28,          // m, propeller diameter
      propRpmMax: 4200,     // shaft rpm at full throttle
      polePairs: 5,         // ERPM = rpm * pole pairs
      Ct0: 0.07,            // thrust coefficient at J=0 (bollard)
      Cq0: 0.0048,          // torque coefficient at J=0
      J0: 1.1,              // advance ratio where thrust reaches zero
      ventLoss: 0.45,       // max thrust loss from ventilation
      reverseRatio: 0.4,    // reverse throttle limit
      // thermal (VESC + motor): T' = P*h - (T-25)/tau, steady dT = P*h*tau
      // FET: +60 °C at 20 kW, tau 50 s. Motor: +75 °C, tau 80 s.
      heatFet: 6.0e-5, tauFet: 50,
      heatMot: 4.7e-5, tauMot: 80,
      fetLimitC: 85, motLimitC: 105, derateBandC: 15,
      // drag
      CdA_forward: 0.020, // m², forward Cd*A (slender displacement hull)
      CdA_wave: 0.08,     // m², wave-making peak at the hump
      CdA_sea: 0.006,     // m², head-sea added resistance
      CdA_rudder: 0.010,  // m², extra drag at full rudder
      CdA_lateral: 0.90,  // m², sideways Cd*A
      dragLinear: 25,     // N*s/m, low-speed viscous damping
      planingDrop: 0.4,   // wetted area reduction when planing
      // wind (superstructure)
      CdA_airF: 0.35,     // m², head wind
      CdA_airL: 1.6,      // m², beam wind
      gustTau: 3.0,       // s, gust time constant (OU)
      gustSigma: 0.35,    // gust strength relative to base wind
      // yaw
      Iz: 1400,           // kg*m², yaw inertia
      rudderCoef: 140,    // torque = lift * coef * flow speed
      yawDamping: 1800,   // N*m*s
    }, params);

    this.state = {
      x: 0, z: 0,          // position (m)
      vx: 0, vz: 0,        // world-frame velocity (m/s)
      heading: 0,          // rad
      yawRate: 0,          // rad/s
      throttle: 0,         // 0..1
      rudder: 0,           // -1..1
      // telemetry
      speed: 0,            // forward speed (m/s)
      thrustN: 0,
      dragN: 0,
      powerW: 0,           // electrical power delivered by the source
      energyPct: 100,
      sourceLabel: '—',
      rpm: 0,              // shaft rpm
      erpm: 0,             // electrical rpm (as seen by the VESC)
      froude: 0,
      planing: 0,          // 0 = displacement, 1 = fully planing
      tempFet: 25,         // °C
      tempMotor: 25,       // °C
      thermalDerate: 1,    // 1 = full power
      windX: 0, windZ: 0,  // effective wind (base + gust)
      hitWall: false,
    };

    this.wind = { x: 0, z: 0 };  // base wind, set from main.js
    this.gust = { x: 0, z: 0 };  // OU gust deviation
    this.colliders = [];         // [{x0,x1,z0,z1}]
    this.energy = null;          // Battery / FuelCell / Solar
  }

  step(dt, input) {
    const p = this.p, s = this.state;

    // 1) Input smoothing
    const tTarget = input.forward ? 1 : (input.back ? -p.reverseRatio : 0);
    s.throttle += (tTarget - s.throttle) * Math.min(1, dt * 3);
    const rTarget = (input.left ? -1 : 0) + (input.right ? 1 : 0);
    s.rudder += (rTarget - s.rudder) * Math.min(1, dt * 5);

    // 2) Velocity in body axes
    const fx = Math.sin(s.heading), fz = Math.cos(s.heading);
    const vF = s.vx * fx + s.vz * fz; // surge
    const vL = s.vx * fz - s.vz * fx; // sway

    // 3) Thermal derating from last frame's temperatures.
    // Power cap falls inside the limit band, never below 20%.
    const derFet = 1 - smoothstep((s.tempFet - p.fetLimitC) / p.derateBandC);
    const derMot = 1 - smoothstep((s.tempMotor - p.motLimitC) / p.derateBandC);
    const derate = Math.max(0.2, Math.min(derFet, derMot));
    s.thermalDerate = derate;
    const powerCap = p.motorPowerMax * derate;

    // 4) Propeller, motor and energy source
    const nMax = p.propRpmMax / 60;                  // rev/s
    const nDes = Math.abs(s.throttle) * nMax;
    const dir = Math.sign(s.throttle) || 1;
    let thrust = 0, availW = 0, n = 0;

    if (nDes > 0.5) {
      const D = p.propD;
      const J1 = Math.max(0, (dir * vF) / (nDes * D + 1e-6));
      const Cq = p.Cq0 * Math.max(0.25, 1 - 0.5 * J1 / p.J0);
      const Q = Cq * ENV.rhoWater * nDes * nDes * D ** 5;    // N*m
      const requestW = Math.min(powerCap,
        (2 * Math.PI * nDes * Q) / p.motorEff);
      availW = this.energy ? this.energy.draw(requestW, dt) : requestW;
      // If power was limited, shaft speed drops: P ~ n^3, so n ~ cbrt(P)
      const scale = requestW > 1 ? Math.cbrt(Math.max(0, availW / requestW)) : 0;
      n = nDes * scale;
      const J2 = Math.max(0, (dir * vF) / (n * D + 1e-6));
      let Ct = p.Ct0 * Math.max(0, 1 - J2 / p.J0);
      // Ventilation at low advance ratio and high rpm
      const vent = smoothstep((n / nMax - 0.6) / 0.35)
                 * smoothstep((0.18 - J2) / 0.18);
      Ct *= 1 - p.ventLoss * vent;
      thrust = dir * Ct * ENV.rhoWater * n * n * D ** 4;
    } else {
      // Still tick the source so the solar buffer charges and the
      // fuel cell ramps down.
      availW = this.energy ? this.energy.draw(0, dt) : 0;
    }

    // 5) Thermal integration: T' = P*h - (T-25)/tau
    s.tempFet += (availW * p.heatFet - (s.tempFet - 25) / p.tauFet) * dt;
    s.tempMotor += (availW * p.heatMot - (s.tempMotor - 25) / p.tauMot) * dt;

    // 6) Drag: hull + hump/planing + head sea + rudder
    const Fr = Math.abs(vF) / Math.sqrt(ENV.g * p.Lwl);
    const plan = smoothstep((Fr - 0.7) / 0.4);
    const CdAF = p.CdA_forward * (1 - p.planingDrop * plan);
    const hump = Math.exp(-(((Fr - 0.5) / 0.18) ** 2)) * (1 - plan);
    const vMag = Math.hypot(s.vx, s.vz);
    let headFac = 0;
    if (vMag > 0.5) {
      const dot = (s.vx * SEA_DIR.x + s.vz * SEA_DIR.z) / vMag;
      headFac = 0.5 * (1 - dot);
    }
    const CdA_total = CdAF + p.CdA_wave * hump + p.CdA_sea * headFac
                    + p.CdA_rudder * s.rudder * s.rudder;
    const kF = 0.5 * ENV.rhoWater * CdA_total;
    const kL = 0.5 * ENV.rhoWater * p.CdA_lateral;
    const dragF = kF * vF * Math.abs(vF) + p.dragLinear * vF;
    const dragL = kL * vL * Math.abs(vL) + p.dragLinear * 4 * vL;

    // 7) Wind: base + Ornstein-Uhlenbeck gust (mean-reverting noise)
    const baseMs = Math.hypot(this.wind.x, this.wind.z);
    const sig = baseMs * p.gustSigma * Math.sqrt(dt);
    this.gust.x += (-this.gust.x / p.gustTau) * dt + sig * (Math.random() * 2 - 1) * 1.73;
    this.gust.z += (-this.gust.z / p.gustTau) * dt + sig * (Math.random() * 2 - 1) * 1.73;
    if (baseMs < 0.01) { this.gust.x = 0; this.gust.z = 0; }
    const wX = this.wind.x + this.gust.x;
    const wZ = this.wind.z + this.gust.z;
    s.windX = wX; s.windZ = wZ;
    const rwx = wX - s.vx, rwz = wZ - s.vz;    // relative wind
    const rwF = rwx * fx + rwz * fz;
    const rwL = rwx * fz - rwz * fx;
    const windF = 0.5 * ENV.rhoAir * p.CdA_airF * rwF * Math.abs(rwF);
    const windL = 0.5 * ENV.rhoAir * p.CdA_airL * rwL * Math.abs(rwL);

    // 8) Newton's second law with added mass
    const aF = (thrust - dragF + windF) / (p.mass * p.addedMassF);
    const aL = (-dragL + windL) / (p.mass * p.addedMassL);
    s.vx += (aF * fx + aL * fz) * dt;
    s.vz += (aF * fz - aL * fx) * dt;

    // 9) Rudder in the propeller slipstream, with stall.
    // Actuator disk outflow: v_flow = sqrt(vF^2 + 2*T/(rho*A_prop))
    // Stall curve: lift ~ r - 0.35*r^3
    let flowRud = vF;
    if (thrust > 0) {
      const Aprop = Math.PI * p.propD * p.propD / 4;
      flowRud = Math.sqrt(vF * vF + 2 * thrust / (ENV.rhoWater * Aprop));
    }
    const lift = s.rudder * (1 - 0.35 * s.rudder * s.rudder);
    const torque = -lift * p.rudderCoef * flowRud - p.yawDamping * s.yawRate;
    s.yawRate += (torque / p.Iz) * dt;
    s.heading += s.yawRate * dt;

    // 10) Integrate position
    s.x += s.vx * dt;
    s.z += s.vz * dt;

    // 11) Shoreline collision.
    // Walls are inflated by the hull radius; on penetration the boat is
    // pushed out along the shallowest axis with a small bounce, and
    // tangential speed is reduced by friction.
    s.hitWall = false;
    const r = p.hullRadius;
    for (const c of this.colliders) {
      if (s.x > c.x0 - r && s.x < c.x1 + r && s.z > c.z0 - r && s.z < c.z1 + r) {
        const pl = s.x - (c.x0 - r), pr = (c.x1 + r) - s.x;
        const pb = s.z - (c.z0 - r), pt = (c.z1 + r) - s.z;
        const m = Math.min(pl, pr, pb, pt);
        if (m === pl)      { s.x = c.x0 - r; if (s.vx > 0) s.vx *= -0.2; }
        else if (m === pr) { s.x = c.x1 + r; if (s.vx < 0) s.vx *= -0.2; }
        else if (m === pb) { s.z = c.z0 - r; if (s.vz > 0) s.vz *= -0.2; }
        else               { s.z = c.z1 + r; if (s.vz < 0) s.vz *= -0.2; }
        const fric = Math.max(0, 1 - 4 * dt);
        s.vx *= fric; s.vz *= fric;
        s.yawRate *= Math.max(0, 1 - 6 * dt);
        s.hitWall = true;
      }
    }

    // 12) Telemetry
    s.speed = vF;
    s.thrustN = thrust;
    s.dragN = dragF;
    s.powerW = availW;
    s.rpm = n * 60;
    s.erpm = Math.round(s.rpm * p.polePairs);
    s.froude = Fr;
    s.planing = plan;
    if (this.energy) {
      s.energyPct = this.energy.pct;
      s.sourceLabel = this.energy.label;
    }
  }
}
