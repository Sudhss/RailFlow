/**
 * The layout wave.
 *
 * Moving between the diagram basis and the geographic basis is not a
 * cross-fade. A cross-fade says "here are two pictures". A railway changes
 * state by propagation: a signal clears, the section behind it clears, and the
 * change travels down the line. So the morph travels too -- it starts at the
 * operator's current focus and sweeps outward along the corridor at a finite
 * speed, and the track is genuinely mid-deformation everywhere in between.
 *
 * The identical function runs on the GPU for the track geometry and on the CPU
 * for train placement. They must agree exactly or trains drift off the rails
 * during a transition, so both come from this one definition.
 */

/** How much of the transition is spent travelling rather than settling. */
export const WAVE_SPREAD = 0.55;

/**
 * @param corridor 0..1 position of this point along the corridor
 * @param origin   0..1 position the change radiates from
 * @param progress 0..1 overall transition progress
 */
export function waveAt(corridor, origin, progress) {
  const distance = Math.abs(corridor - origin);
  const delay = distance * WAVE_SPREAD;
  const local = (progress - delay) / (1 - WAVE_SPREAD);
  const t = Math.max(0, Math.min(1, local));
  return t * t * (3 - 2 * t); // smoothstep
}

/** The same function as GLSL, injected into the track shader. */
export const WAVE_GLSL = /* glsl */ `
  uniform float uWaveOrigin;
  uniform float uWaveProgress;

  float waveAt(float corridor) {
    float distance = abs(corridor - uWaveOrigin);
    float delay = distance * ${WAVE_SPREAD.toFixed(3)};
    float local = (uWaveProgress - delay) / (1.0 - ${WAVE_SPREAD.toFixed(3)});
    return smoothstep(0.0, 1.0, clamp(local, 0.0, 1.0));
  }
`;
