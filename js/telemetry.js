// Telemetry recorder.
// Samples at a fixed rate (4 Hz) so the log size and chart time axis do
// not depend on frame rate. Distance and energy are integrated every
// frame so nothing is lost between samples.
//
// Outputs: sample arrays (charts), stats() (run summary incl. Wh/km)
// and toCSV() (export for Excel/Python).

export class Telemetry {
  constructor(intervalS = 0.25, maxSamples = 4800) { // 4 Hz, 20 min
    this.intervalS = intervalS;
    this.maxSamples = maxSamples;
    this.clear();
  }

  clear() {
    this.t = [];   // time since run start (s)
    this.v = [];   // speed (m/s)
    this.p = [];   // power (W)
    this.e = [];   // energy (%)
    this.x = [];   // position
    this.z = [];
    this.t0 = null;
    this.nextT = 0;
    this.distM = 0;
    this.usedWh = 0;
  }

  // Called every frame; returns true when a new sample was stored.
  sample(state, time, dt) {
    this.distM += Math.hypot(state.vx, state.vz) * dt;
    this.usedWh += state.powerW * dt / 3600;

    if (time < this.nextT) return false;
    this.nextT = time + this.intervalS;
    if (this.t0 === null) this.t0 = time;
    if (this.t.length >= this.maxSamples) return false;

    this.t.push(time - this.t0);
    this.v.push(state.speed);
    this.p.push(state.powerW);
    this.e.push(state.energyPct);
    this.x.push(state.x);
    this.z.push(state.z);
    return true;
  }

  stats() {
    const dur = this.t.length ? this.t[this.t.length - 1] : 0;
    const distKm = this.distM / 1000;
    return {
      durationS: dur,
      distM: this.distM,
      avgKmh: dur > 0 ? (this.distM / dur) * 3.6 : 0,
      usedWh: this.usedWh,
      whPerKm: distKm > 0.01 ? this.usedWh / distKm : 0,
    };
  }

  toCSV() {
    const rows = ['t_s;speed_ms;power_W;energy_pct;x_m;z_m'];
    for (let i = 0; i < this.t.length; i++) {
      rows.push([
        this.t[i].toFixed(2), this.v[i].toFixed(3), this.p[i].toFixed(0),
        this.e[i].toFixed(2), this.x[i].toFixed(2), this.z[i].toFixed(2),
      ].join(';'));
    }
    return rows.join('\n');
  }
}
