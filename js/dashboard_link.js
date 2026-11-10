// Web Serial bridge to the ground station.
// Converts the simulated boat state into the same key:value telemetry
// packet the RC boat firmware sends (lora_send), so ground_station.py
// can be driven by either the sim or the real boat.
//
//   Browser (Chrome/Edge) --Web Serial--> com0com virtual COM pair
//   other end of the pair ---------------> ground_station.py
//
// Web Serial needs a secure context, so serve the sim from
// http://localhost (file:// will not work). requestPort() must be
// called from a user gesture (the L key).

const BUS_V_NOMINAL = 84.0; // nominal bus voltage of the VESC 75200 setup (V)
const ERPM_PER_MS = 2500;   // speed (m/s) -> ERPM, rough mapping
const SEND_HZ = 5;

export class DashboardLink {
  constructor() {
    this.port = null;
    this.writer = null;
    this._lastSend = -1;
    this._encoder = new TextEncoder();
  }

  get connected() {
    return this.writer !== null;
  }

  async connect() {
    if (this.connected) {
      await this.disconnect();
      return;
    }
    if (!('serial' in navigator)) {
      alert('Web Serial is not supported. Use Chrome or Edge over localhost.');
      return;
    }
    try {
      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: 9600 });
      this.writer = this.port.writable.getWriter();
      console.log('[dashboard] connected, streaming telemetry (L to disconnect)');
    } catch (err) {
      console.warn('[dashboard] connection cancelled or failed:', err);
      this.port = null;
      this.writer = null;
    }
  }

  async disconnect() {
    try {
      if (this.writer) {
        await this.writer.close();
        this.writer = null;
      }
      if (this.port) {
        await this.port.close();
        this.port = null;
      }
      console.log('[dashboard] disconnected');
    } catch (_) {
      this.writer = null;
      this.port = null;
    }
  }

  // Called every frame; rate-limited to SEND_HZ.
  maybeSend(boat, time) {
    if (!this.writer) return;
    if (this._lastSend >= 0 && time - this._lastSend < 1 / SEND_HZ) return;
    this._lastSend = time;

    const s = boat.userData.state;
    const q = boat.quaternion; // full orientation (yaw + wave pitch/roll)

    // Pack voltage sags slightly as energy drops.
    const voltage = BUS_V_NOMINAL * (0.92 + 0.08 * (s.energyPct / 100));
    const current = voltage > 1 ? s.powerW / voltage : 0;
    const erpm = Math.round(s.speed * ERPM_PER_MS);
    const duty = Math.max(0, Math.min(1, s.throttle));
    const speedKmh = s.speed * 3.6;

    // Load-based temperature estimate for the packet.
    const load = Math.max(0, Math.min(1, s.powerW / 20000));
    const tFet = 25 + load * 35; // 25..60 °C
    const tMot = 25 + load * 45; // 25..70 °C

    const pkt =
      `E:${erpm},C:${current.toFixed(2)},D:${duty.toFixed(3)},S:${speedKmh.toFixed(2)},` +
      `W:${q.w.toFixed(4)},X:${q.x.toFixed(4)},Y:${q.y.toFixed(4)},Z:${q.z.toFixed(4)},` +
      `V:${voltage.toFixed(1)},TF:${tFet.toFixed(1)},TM:${tMot.toFixed(1)}\n`;

    this.writer.write(this._encoder.encode(pkt)).catch(() => {
      this.writer = null;
      this.port = null;
    });
  }
}
