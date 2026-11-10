// Power sources.
// The motor cannot take whatever power it wants; it gets what the
// source can deliver.
//
// Common interface: draw(requestW, dt) -> deliveredW
// Called every frame, even with a zero request, so the solar buffer
// can charge and the fuel cell output can ramp down.
//
//   Battery  : high power, limited energy, internal resistance losses
//   Hydrogen : medium power, large energy, slow response + buffer
//   Solar    : low continuous power + buffer battery, MPPT and
//              panel temperature losses

class PowerSource {
  constructor(label, capacityWh) {
    this.label = label;
    this.capacityWh = capacityWh;
    this.remainingWh = capacityWh;
  }
  get pct() { return Math.max(0, 100 * this.remainingWh / this.capacityWh); }
  reset() { this.remainingWh = this.capacityWh; }
}

// Battery modelled as an ideal source Voc with series resistance R.
//   Terminal power: P = Voc*I - I^2*R, solved for I:
//   I = (Voc - sqrt(Voc^2 - 4*R*P)) / (2R)
// Energy drawn from the pack is Voc*I; the I^2*R part becomes heat.
// Efficiency is ~99% at low power and ~93% at full power.
// Voc also drops with state of charge (simplified Li-ion curve).
export class Battery extends PowerSource {
  constructor({ capacityWh = 5000, maxPowerW = 20000,
                packV = 84, internalR = 0.025 } = {}) {
    super('Battery', capacityWh);
    this.maxPowerW = maxPowerW;
    this.packV = packV;         // open-circuit voltage when full (V)
    this.internalR = internalR; // pack internal resistance (ohm)
    this.terminalV = packV;
    this.currentA = 0;
  }
  draw(requestW, dt) {
    if (this.remainingWh <= 0) { this.currentA = 0; return 0; }
    const soc = this.remainingWh / this.capacityWh;
    const voc = this.packV * (0.85 + 0.15 * soc);
    // Internal resistance caps power at Voc^2/4R.
    const pCeil = 0.98 * voc * voc / (4 * this.internalR);
    let p = Math.min(requestW, this.maxPowerW, pCeil);
    if (soc < 0.10) p *= soc / 0.10; // deep discharge: cell voltage collapses
    const I = p > 0
      ? (voc - Math.sqrt(Math.max(0, voc * voc - 4 * this.internalR * p)))
        / (2 * this.internalR)
      : 0;
    let usedWh = (voc * I) * dt / 3600;
    if (usedWh > this.remainingWh) {
      p *= this.remainingWh / usedWh;
      usedWh = this.remainingWh;
    }
    this.remainingWh -= usedWh;
    this.currentA = I;
    this.terminalV = voc - I * this.internalR;
    return p;
  }
}

// Hydrogen fuel cell with slew-limited output and a buffer battery.
// 1 kg H2 is about 33.3 kWh (LHV); the stack converts at ~50%.
// The stack cannot change output instantly, so it ramps at slewWps.
// A small buffer covers sudden demand and absorbs surplus.
export class FuelCell extends PowerSource {
  constructor({ kgH2 = 0.5, maxPowerW = 10000, efficiency = 0.50,
                slewWps = 1500, bufferWh = 300, bufferMaxW = 6000 } = {}) {
    super('Hydrogen', kgH2 * 33330); // chemical energy in Wh
    this.maxPowerW = maxPowerW;
    this.efficiency = efficiency;
    this.slewWps = slewWps;
    this.bufferCap = bufferWh;
    this.bufferWh = bufferWh;
    this.bufferMaxW = bufferMaxW;
    this.outputW = 0; // current stack output
  }
  reset() { super.reset(); this.bufferWh = this.bufferCap; this.outputW = 0; }
  draw(requestW, dt) {
    // Ramp toward the target; ramping down is 3x faster than up.
    const target = Math.min(requestW, this.maxPowerW);
    const up = this.slewWps * dt, down = 3 * up;
    if (target > this.outputW) this.outputW = Math.min(target, this.outputW + up);
    else this.outputW = Math.max(target, this.outputW - down);
    if (this.remainingWh <= 0) this.outputW = 0;

    let fcW = this.outputW;
    const chemWh = (fcW / this.efficiency) * dt / 3600;
    if (chemWh > this.remainingWh) {
      fcW *= this.remainingWh / chemWh;
      this.remainingWh = 0;
      this.outputW = fcW;
    } else {
      this.remainingWh -= chemWh;
    }

    // Stack feeds the load first; surplus charges the buffer,
    // the buffer covers any deficit.
    const toLoad = Math.min(fcW, requestW);
    let out = toLoad;
    const surplus = fcW - toLoad;
    if (surplus > 0) {
      this.bufferWh = Math.min(this.bufferCap,
        this.bufferWh + surplus * 0.9 * dt / 3600); // 90% charge efficiency
    }
    const deficit = requestW - toLoad;
    if (deficit > 0 && this.bufferWh > 0) {
      let b = Math.min(deficit, this.bufferMaxW);
      const wh = b * dt / 3600;
      if (wh > this.bufferWh) { b *= this.bufferWh / wh; this.bufferWh = 0; }
      else this.bufferWh -= wh;
      out += b;
    }
    return out;
  }
}

// Solar panel (6 m², 22%) with MPPT and a buffer battery.
// Losses between panel and bus:
//   a) cell temperature (NOCT model: T_cell = T_air + (NOCT-20)/800 * G),
//      about -0.4%/°C; at full noon sun the cells reach ~56 °C
//   b) MPPT converter efficiency (~97%)
// Demand above panel output comes from the buffer; surplus charges it.
export class Solar extends PowerSource {
  constructor({ panelM2 = 6, panelEff = 0.22, bufferWh = 1000, maxPowerW = 8000,
                mpptEff = 0.97, tempCoef = -0.004, noctC = 45, ambientC = 24 } = {}) {
    super('Solar+Buffer', bufferWh); // remainingWh = buffer charge
    this.panelM2 = panelM2;
    this.panelEff = panelEff;
    this.maxPowerW = maxPowerW;      // buffer discharge limit
    this.mpptEff = mpptEff;
    this.tempCoef = tempCoef;        // power temperature coefficient (1/°C)
    this.noctC = noctC;              // nominal operating cell temperature
    this.ambientC = ambientC;
    this.sunWm2 = 1000;              // set by main.js from time of day
  }
  get cellTempC() {
    return this.ambientC + (this.noctC - 20) / 800 * this.sunWm2;
  }
  get panelW() {
    const raw = this.sunWm2 * this.panelM2 * this.panelEff;
    const tempDerate = 1 + this.tempCoef * (this.cellTempC - 25);
    return Math.max(0, raw * tempDerate * this.mpptEff);
  }
  draw(requestW, dt) {
    const sunW = this.panelW;
    const fromSun = Math.min(requestW, sunW);
    let fromBuffer = 0;
    const deficit = requestW - fromSun;
    if (deficit > 0 && this.remainingWh > 0) {
      fromBuffer = Math.min(deficit, this.maxPowerW);
      const usedWh = fromBuffer * dt / 3600;
      if (usedWh > this.remainingWh) {
        fromBuffer *= this.remainingWh / usedWh;
        this.remainingWh = 0;
      } else {
        this.remainingWh -= usedWh;
      }
    }
    const surplus = sunW - fromSun;
    if (surplus > 0) {
      this.remainingWh = Math.min(this.capacityWh,
        this.remainingWh + surplus * 0.9 * dt / 3600); // 90% charge efficiency
    }
    return fromSun + fromBuffer;
  }
}
