import * as THREE from 'three';

// Port Hercule (Monaco) layout, simplified. Sim axes: +z = north,
// +x = east.
//
//   South : Le Rocher with the palace on top, Quai Antoine 1er below
//   West  : Quai Albert 1er and La Condamine, Tête de Chien behind
//   East  : Digue Rainier III (352 m floating breakwater); open sea
//           beyond it, where the sprint course runs
//   North : Quai Louis II and the Yacht Club building; harbour
//           entrance with the counter-jetty in the north-east corner
//   NE    : Monte Carlo hillside and casino
//
// The race area in the middle of the harbour is left open.

// Shoreline colliders, matching the quay/wall boxes below. The physics
// treats them as AABBs. Add new walls here as well.
export const COLLIDERS = [
  { x0: -96, x1: -78, z0: -40,  z1: 300 }, // Quai Albert 1er (west)
  { x0: -95, x1: 75,  z0: 266,  z1: 284 }, // Quai Louis II + YCM (north)
  { x0: 77,  x1: 93,  z0: -35,  z1: 211 }, // Digue Rainier III (east)
  { x0: 72,  x1: 80,  z0: 238,  z1: 270 }, // counter-jetty (NE entrance)
  { x0: -78, x1: 22,  z0: -22,  z1: -6 },  // Quai Antoine 1er (south)
  { x0: 25,  x1: 85,  z0: -32,  z1: -20 }, // Rocher to breakwater link
  { x0: -92, x1: 42,  z0: -104, z1: -20 }, // Le Rocher
];

export function createEnvironment(scene) {
  const g = new THREE.Group();
  const mat = (color, roughness = 0.85) =>
    new THREE.MeshStandardMaterial({ color, roughness });
  const box = (w, h, d, m, x, y, z, ry = 0) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    b.position.set(x, y, z);
    b.rotation.y = ry;
    g.add(b);
    return b;
  };

  const quayMat = mat(0x9a938a);
  const stone = mat(0x5b5f66);
  const white = mat(0xf4f2ec, 0.6);

  // Seeded RNG so the town looks the same on every load
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const palette = [0xf1e0c8, 0xe8cfa8, 0xd9b48f, 0xc9976b, 0xf5ead3, 0xd8a88f];
  const pastel = () => mat(palette[Math.floor(rand() * palette.length)]);

  // South: Le Rocher
  box(100, 2.5, 16, quayMat, -28, 0.75, -14);      // Quai Antoine 1er
  box(130, 24, 80, mat(0x7d715f, 1), -25, 11, -62, -0.06);
  box(26, 9, 14, white, -52, 27.5, -58);           // palace
  box(10, 12, 10, white, -36, 29, -60);            // palace tower
  box(18, 7, 12, pastel(), -14, 26.5, -55);
  box(14, 6, 10, pastel(), 2, 26, -62);
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 12, 10), white);
  tower.position.set(-62, 29, -52);
  g.add(tower);

  box(60, 3.5, 12, stone, 55, 1.0, -26);           // link to breakwater

  // East: Digue Rainier III
  box(16, 5, 245, stone, 85, 1.6, 88);
  box(8, 2.5, 160, mat(0x767a80), 85, 5.3, 60);    // deck structure
  // Breakwater head light: port side for an inbound boat, IALA-A red
  const redLight = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 7, 10),
    mat(0xd03b3b, 0.5));
  redLight.position.set(85, 5, 207);
  g.add(redLight);

  // NE: counter-jetty and entrance
  box(8, 4, 32, stone, 76, 1.2, 254);
  // Starboard side for an inbound boat: green
  const greenLight = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 6, 10),
    mat(0x0ca30c, 0.5));
  greenLight.position.set(76, 4.5, 240);
  g.add(greenLight);

  // North: Quai Louis II and Yacht Club
  box(170, 3, 18, quayMat, -10, 0.9, 275);
  box(48, 4.5, 13, white, 32, 5.2, 279);
  box(42, 3.5, 11, white, 32, 9.2, 281);
  box(34, 3, 9, white, 32, 12.4, 283);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 12, 8), white);
  mast.position.set(50, 18, 282);
  g.add(mast);

  // West: Quai Albert 1er and La Condamine
  box(18, 3, 340, quayMat, -87, 0.9, 130);
  // Rows of buildings climbing the hillside westward
  for (let i = 0; i < 56; i++) {
    const row = Math.floor(i / 14);
    const bx = -108 - row * 24 - rand() * 10;
    const bz = -30 + (i % 14) * 24 + rand() * 12;
    const w = 8 + rand() * 10;
    const h = 10 + rand() * 12 + row * 4;
    const base = 2 + row * 8;
    box(w, h, 9 + rand() * 8, pastel(), bx, base + h / 2, bz, (rand() - 0.5) * 0.3);
  }

  // NE: Monte Carlo hillside and casino
  for (let i = 0; i < 24; i++) {
    const row = Math.floor(i / 8);
    const bx = -60 + (i % 8) * 17 + rand() * 10;
    const bz = 300 + row * 26 + rand() * 12;
    const w = 9 + rand() * 9;
    const h = 12 + rand() * 12 + row * 5;
    const base = 3 + row * 9;
    box(w, h, 10 + rand() * 8, pastel(), bx, base + h / 2, bz, (rand() - 0.5) * 0.25);
  }
  box(26, 10, 16, mat(0xe9dcc0, 0.7), 50, 19, 328);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(6, 14, 10,
    0, Math.PI * 2, 0, Math.PI / 2), mat(0x6fa08a, 0.5));
  dome.position.set(50, 24, 328);
  g.add(dome);

  // Background masses, silhouetted by fog
  box(340, 130, 680, mat(0x6b7a5e, 1), -330, 34, 150, 0.05); // Tête de Chien
  box(320, 95, 300, mat(0x71806a, 1), -80, 24, 520);

  scene.add(g);
  return g;
}
