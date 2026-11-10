import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { getWaveHeight } from './water.js';
import { BoatPhysics } from './physics.js';
import { Battery, FuelCell, Solar } from './energy.js';

// Energy Class catamaran (~6.5 m). The mesh comes from assets/boat.glb
// (source: assets/boat.blend). Blender -Y forward exports as +Z, which
// matches the physics frame. Motion lives in physics.js; this file
// handles the visual model and the buoyancy response to waves.

export function createBoat() {
  const group = new THREE.Group();

  // The GLB loads asynchronously; physics already moves the group, so
  // the model appears in the right place as soon as it arrives.
  new GLTFLoader().load(
    './assets/boat.glb',
    (gltf) => { group.add(gltf.scene); },
    undefined,
    (err) => console.error('Failed to load boat.glb:', err),
  );

  const phys = new BoatPhysics();
  const s = phys.state;
  group.userData.state = s;

  // Power sources, switched with keys 1/2/3. Each keeps its own charge.
  const sources = {
    Digit1: new Battery(),
    Digit2: new FuelCell(),
    Digit3: new Solar(),
  };
  phys.energy = sources.Digit1;

  group.userData.setSource = (code) => {
    if (sources[code]) phys.energy = sources[code];
  };
  group.userData.setSunIrradiance = (wm2) => {
    sources.Digit3.sunWm2 = wm2;
  };
  group.userData.setWind = (x, z) => {
    phys.wind.x = x;
    phys.wind.z = z;
  };
  group.userData.setColliders = (list) => {
    phys.colliders = list;
  };
  group.userData.resetEnergy = () => {
    Object.values(sources).forEach((src) => src.reset());
  };

  // Move the boat to a course start, clearing velocity and inputs.
  group.userData.teleport = (x, z, heading) => {
    s.x = x; s.z = z; s.heading = heading;
    s.vx = 0; s.vz = 0; s.yawRate = 0;
    s.throttle = 0; s.rudder = 0;
    group.position.set(x, 0, z);
    group.rotation.set(0, heading, 0);
  };

  // Heave, pitch and roll are each a damped spring toward the local
  // water surface: buoyancy acts as the spring, the water as damping.
  let heaveV = 0, pitchV = 0, rollV = 0;
  const sstep = (t) => {
    t = Math.max(0, Math.min(1, t));
    return t * t * (3 - 2 * t);
  };

  group.userData.update = (dt, time, input) => {
    phys.step(dt, input);

    group.position.x = s.x;
    group.position.z = s.z;
    group.rotation.y = s.heading;

    // Sample the water at bow/stern and on both hull lines (±1.3 m).
    const fx = Math.sin(s.heading), fz = Math.cos(s.heading);
    const bowY   = getWaveHeight(s.x + fx * 3, s.z + fz * 3, time);
    const sternY = getWaveHeight(s.x - fx * 3, s.z - fz * 3, time);
    const leftY  = getWaveHeight(s.x + fz * 1.3, s.z - fx * 1.3, time);
    const rightY = getWaveHeight(s.x - fz * 1.3, s.z + fx * 1.3, time);

    // Heave. wn = natural frequency, zeta = damping ratio.
    const targetY = (bowY + sternY + leftY + rightY) / 4;
    const wnH = 3.2, zH = 0.55;
    heaveV += (wnH * wnH * (targetY - group.position.y) - 2 * zH * wnH * heaveV) * dt;
    group.position.y += heaveV * dt;

    // Pitch: wave slope plus squat/trim. Around the hump the bow rises
    // (~3 deg), once planing it settles to ~1 deg.
    const wavePitch = Math.atan2(sternY - bowY, 6);
    const bowUp = 0.055 * sstep((s.froude - 0.3) / 0.4) * (1 - 0.65 * s.planing)
                + 0.018 * s.planing;
    const pitchT = wavePitch - bowUp; // negative rotation.x = bow up
    const wnP = 2.8, zP = 0.5;
    pitchV += (wnP * wnP * (pitchT - group.rotation.x) - 2 * zP * wnP * pitchV) * dt;
    group.rotation.x += pitchV * dt;

    // Roll: wave roll plus lean into turns.
    const waveRoll = Math.atan2(rightY - leftY, 2);
    const turnLean = s.yawRate * s.speed * 0.015;
    const rollT = waveRoll + turnLean;
    const wnR = 3.0, zR = 0.45;
    rollV += (wnR * wnR * (rollT - group.rotation.z) - 2 * zR * wnR * rollV) * dt;
    group.rotation.z += rollV * dt;
  };

  return group;
}
