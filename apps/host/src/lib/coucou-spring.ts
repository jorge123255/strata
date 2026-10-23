/** Coucou spring. Same integrator as windows/src/core/anim.ts: ω₀ = 2π / response, ζ = damping. */

export const closeCurve = cubicBezier(0.45, 0, 0.2, 1);

export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = (t: number) => ((1 - t) ** 2 * 3 * t * x1) + (3 * (1 - t) * t * t * x2) + t ** 3;
  const cy = (t: number) => ((1 - t) ** 2 * 3 * t * y1) + (3 * (1 - t) * t * t * y2) + t ** 3;
  return (x: number) => {
    let lo = 0;
    let hi = 1;
    let t = x;
    for (let i = 0; i < 12; i++) {
      const v = cx(t);
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return cy(t);
  };
}

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));

/** SwiftUI-style spring. Open motion uses response 0.5 and damping 0.72. */
export class Spring {
  value: number;
  target: number;
  velocity = 0;
  omega: number;
  zeta: number;

  constructor(value: number, response = 0.5, damping = 0.72) {
    this.value = value;
    this.target = value;
    this.omega = (2 * Math.PI) / response;
    this.zeta = damping;
  }

  configure(response: number, damping: number) {
    this.omega = (2 * Math.PI) / response;
    this.zeta = damping;
  }

  set(value: number) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }

  get settled() {
    return Math.abs(this.target - this.value) < 0.01 && Math.abs(this.velocity) < 0.05;
  }

  step(dt: number) {
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const acc = this.omega * this.omega * (this.target - this.value) - 2 * this.zeta * this.omega * this.velocity;
      this.velocity += acc * h;
      this.value += this.velocity * h;
    }
  }
}

/** Grow with a spring. Shrink on the 340ms close curve, with no overshoot. */
export class Tracked {
  private spring: Spring;
  private curveFrom = 0;
  private curveTo = 0;
  private curveStart = 0;
  private curveDur = 0;
  private mode: 'spring' | 'curve' | 'idle' = 'idle';

  constructor(value: number) {
    this.spring = new Spring(value);
  }

  get value() {
    return this.spring.value;
  }

  get animating() {
    return this.mode !== 'idle';
  }

  jump(value: number) {
    this.spring.set(value);
    this.mode = 'idle';
  }

  springTo(value: number, response = 0.5, damping = 0.72) {
    this.spring.configure(response, damping);
    this.spring.target = value;
    this.mode = 'spring';
  }

  curveTowards(value: number, durationMs = 340, now = 0) {
    this.curveFrom = this.spring.value;
    this.curveTo = value;
    this.curveStart = now;
    this.curveDur = durationMs;
    this.spring.target = value;
    this.spring.velocity = 0;
    this.mode = 'curve';
  }

  step(dt: number, now = 0) {
    if (this.mode === 'spring') {
      this.spring.step(dt);
      if (this.spring.settled) {
        this.spring.value = this.spring.target;
        this.spring.velocity = 0;
        this.mode = 'idle';
      }
    } else if (this.mode === 'curve') {
      const p = clamp((now - this.curveStart) / this.curveDur, 0, 1);
      this.spring.value = this.curveFrom + (this.curveTo - this.curveFrom) * closeCurve(p);
      if (p >= 1) {
        this.spring.value = this.curveTo;
        this.spring.velocity = 0;
        this.mode = 'idle';
      }
    }
  }
}

/** Evenly spaced samples of one open spring, for CSS linear() easing. */
export function springEase(response = 0.5, damping = 0.72) {
  const spring = new Spring(0, response, damping);
  spring.target = 1;
  const samples = [0];
  const dt = 1 / 60;
  let elapsed = 0;
  while (elapsed < 1.4) {
    spring.step(dt);
    elapsed += dt;
    samples.push(Math.max(-0.25, Math.min(1.35, spring.value)));
    if (spring.settled) break;
  }
  samples.push(1);
  return {
    ms: Math.max(1, Math.round(elapsed * 1000)),
    linear: `linear(${samples.map(sample => sample.toFixed(3)).join(', ')})`,
  };
}
