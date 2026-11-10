import * as THREE from 'three';

// Water surface, two layers:
//   near: detailed wave mesh that follows the boat, samples waves in
//         world coordinates and fades the amplitude toward its edges
//   far:  large flat sea out to the horizon, fading into the fog
//
// getWaveHeight is shared by the renderer and the boat's buoyancy
// sampling, so both see the same surface.

const WAVE = [
  // direction (x,z), wavelength, amplitude, speed
  { dir: new THREE.Vector2(1.0, 0.3).normalize(), length: 18, amp: 0.12, speed: 1.1 },
  { dir: new THREE.Vector2(-0.4, 1.0).normalize(), length: 9,  amp: 0.07, speed: 1.6 },
  { dir: new THREE.Vector2(0.7, -0.8).normalize(), length: 4,  amp: 0.03, speed: 2.3 },
];

// Water height at world (x, z): sum of sine waves.
export function getWaveHeight(x, z, time) {
  let y = 0;
  for (const w of WAVE) {
    const phase = (w.dir.x * x + w.dir.y * z) * (2 * Math.PI / w.length) + time * w.speed;
    y += Math.sin(phase) * w.amp;
  }
  return y;
}

export function createWater(size = 400, segments = 128) {
  const group = new THREE.Group();
  const half = size / 2;
  const cell = size / segments;
  const taperStart = half * 0.65; // amplitude starts fading beyond this radius

  const geo = new THREE.PlaneGeometry(size, size, segments, segments);
  geo.rotateX(-Math.PI / 2);
  const nearMat = new THREE.MeshStandardMaterial({
    color: 0x0e5a7a,
    roughness: 0.32,
    metalness: 0.15,
  });
  const near = new THREE.Mesh(geo, nearMat);
  near.receiveShadow = true;
  group.add(near);

  const farGeo = new THREE.PlaneGeometry(8000, 8000, 1, 1);
  farGeo.rotateX(-Math.PI / 2);
  const farMat = new THREE.MeshStandardMaterial({
    color: 0x0a4a63,
    roughness: 0.5,
    metalness: 0.1,
  });
  const far = new THREE.Mesh(farGeo, farMat);
  far.position.y = -0.06; // slightly below near to avoid z-fighting
  group.add(far);

  const pos = geo.attributes.position;

  group.userData.update = (time, cx = 0, cz = 0) => {
    // Snap to the grid cell size so vertices always sample the same
    // world points; otherwise the mesh shimmers while it moves.
    const ox = Math.round(cx / cell) * cell;
    const oz = Math.round(cz / cell) * cell;
    near.position.x = ox;
    near.position.z = oz;
    far.position.x = ox;
    far.position.z = oz;

    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i);
      const lz = pos.getZ(i);

      const edge = Math.max(Math.abs(lx), Math.abs(lz));
      let k = 1 - (edge - taperStart) / (half - taperStart);
      k = Math.max(0, Math.min(1, k));
      k = k * k * (3 - 2 * k);

      pos.setY(i, getWaveHeight(lx + ox, lz + oz, time) * k);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  };

  return group;
}
