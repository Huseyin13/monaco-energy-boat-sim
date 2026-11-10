import * as THREE from 'three';

// Foam wake using a fixed particle pool: sprites are created once and
// recycled, so nothing is allocated per frame. Each particle spawns at
// the stern, grows, fades out and is reused.

function makeFoamTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(32, 32, 4, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.6, 'rgba(230,242,248,0.45)');
  grad.addColorStop(1, 'rgba(230,242,248,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export function createWake(scene, max = 120) {
  const tex = makeFoamTexture();
  const pool = [];
  for (let i = 0; i < max; i++) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, opacity: 0, depthWrite: false,
    }));
    sprite.visible = false;
    scene.add(sprite);
    pool.push({ sprite, life: 0, maxLife: 0 });
  }
  let cursor = 0;
  let spawnAcc = 0; // fractional spawn accumulator

  function spawn(x, z) {
    const p = pool[cursor];
    cursor = (cursor + 1) % max;
    p.maxLife = 1.8 + Math.random() * 1.2;
    p.life = p.maxLife;
    p.sprite.position.set(x + (Math.random() - 0.5) * 1.6, 0.12,
                          z + (Math.random() - 0.5) * 1.6);
    p.sprite.visible = true;
  }

  return {
    update(dt, s) {
      // Spawn rate scales with speed; no foam at low speed.
      const speed = Math.abs(s.speed);
      if (speed > 1.5) {
        spawnAcc += Math.min(speed, 12) * 3.5 * dt; // ~5-40 per second
        const sternX = s.x - Math.sin(s.heading) * 3.2;
        const sternZ = s.z - Math.cos(s.heading) * 3.2;
        while (spawnAcc >= 1) { spawnAcc -= 1; spawn(sternX, sternZ); }
      }
      for (const p of pool) {
        if (!p.sprite.visible) continue;
        p.life -= dt;
        if (p.life <= 0) { p.sprite.visible = false; p.sprite.material.opacity = 0; continue; }
        const age = 1 - p.life / p.maxLife;
        const scale = 1.0 + age * 4.0;
        p.sprite.scale.set(scale, scale, 1);
        p.sprite.material.opacity = 0.5 * (1 - age);
      }
    },
  };
}
