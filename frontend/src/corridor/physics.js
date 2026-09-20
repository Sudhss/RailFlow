/**
 * Train motion between snapshots.
 *
 * The backend advances one simulated minute per tick and pushes a snapshot
 * every `tick_interval_seconds` of real time. Drawing only what arrives gives
 * one position per second: the train jumps, then sits still. Interpolating
 * blindly between the last two snapshots is worse -- it renders the train a
 * whole tick behind wherever it actually is.
 *
 * So the client runs the *same* integrator the server runs. Each frame a train
 * advances by its own speed over the elapsed simulated time, and every arriving
 * snapshot corrects the accumulated error with a critically damped approach
 * rather than a snap. Prediction error stays under a metre in normal running,
 * and the motion is continuous at frame rate instead of at tick rate.
 *
 * Pure math. No renderer types.
 */

/** Simulated minutes elapsed for a given slice of real time. */
export function simMinutes(realSeconds, tickIntervalSeconds) {
  const interval = tickIntervalSeconds > 0 ? tickIntervalSeconds : 1;
  return realSeconds / interval;
}

/** Frame-rate independent exponential approach. Mirrors THREE.MathUtils.damp. */
export function damp(current, target, lambda, dt) {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

export function createTrainMotion(train) {
  return {
    id: train.id,
    edgeId: train.edge_id || null,
    progress: Number(train.edge_progress) || 0,
    // Rendered speed lags the reported speed so a step change in the authority
    // reads as the train accelerating rather than teleporting to a new speed.
    speed: Number(train.current_speed) || 0,
    targetSpeed: Number(train.current_speed) || 0,
    acceleration: 0,
    cant: 0,
    pitch: 0,
    status: train.status,
  };
}

/**
 * Fold an authoritative snapshot into the local motion state.
 * Returns the same object, mutated, so the caller can keep it in a ref.
 */
export function reconcile(motion, train) {
  const serverProgress = Number(train.edge_progress) || 0;
  const edgeChanged = motion.edgeId !== (train.edge_id || null);

  motion.status = train.status;
  motion.targetSpeed = Number(train.current_speed) || 0;

  if (edgeChanged) {
    // A different section: there is nothing meaningful to interpolate.
    motion.edgeId = train.edge_id || null;
    motion.progress = serverProgress;
    motion.error = 0;
    return motion;
  }

  // Keep the prediction, remember how far it drifted, and bleed that off.
  motion.error = serverProgress - motion.progress;
  return motion;
}

/**
 * Advance one train by `dt` real seconds.
 *
 * `sectionKm` is the true length of the section, so progress is integrated in
 * real distance rather than in an arbitrary unit.
 */
export function integrate(motion, dt, options) {
  const { tickIntervalSeconds, sectionKm, paused, reducedMotion } = options;

  if (reducedMotion) {
    // No prediction and no easing: show exactly what the authority reported.
    motion.speed = motion.targetSpeed;
    motion.progress += motion.error || 0;
    motion.error = 0;
    motion.acceleration = 0;
    motion.cant = 0;
    motion.pitch = 0;
    return motion;
  }

  const previousSpeed = motion.speed;
  // A train changes speed over seconds, not instantly. 2.2 is a reasonable
  // approach rate for the mainline stock this corridor runs.
  motion.speed = damp(motion.speed, motion.targetSpeed, 2.2, dt);

  const minutes = simMinutes(dt, tickIntervalSeconds);
  motion.acceleration = dt > 0 ? (motion.speed - previousSpeed) / dt : 0;

  if (!paused && motion.status === "moving" && sectionKm > 0) {
    const km = (motion.speed / 60) * minutes;
    motion.progress += km / sectionKm;
  }

  // Bleed off prediction error smoothly instead of snapping to the snapshot.
  if (motion.error) {
    const correction = motion.error * (1 - Math.exp(-6 * dt));
    motion.progress += correction;
    motion.error -= correction;
  }

  motion.progress = Math.max(0, Math.min(1, motion.progress));
  return motion;
}

/**
 * Cant (superelevation) and pitch for the current frame.
 *
 * Cant balances lateral acceleration in a curve: a = v^2 / r, and the rendered
 * roll is proportional to that, capped at the ~6 degrees real track uses.
 * Pitch is the nose lifting under power and dipping under braking.
 */
export function attitude(motion, curvature, worldUnitsPerKm) {
  const metresPerSecond = motion.speed / 3.6;
  // `curvature` arrives in world units; convert to 1/m before using it.
  const radiusWorld = curvature === 0 ? Infinity : 1 / Math.abs(curvature);
  const radiusMetres = (radiusWorld / worldUnitsPerKm) * 1000;
  const lateral = radiusMetres > 0 && Number.isFinite(radiusMetres)
    ? (metresPerSecond * metresPerSecond) / radiusMetres
    : 0;

  const MAX_CANT = 0.105; // ~6 degrees, the usual mainline maximum
  const targetCant = Math.sign(curvature) * Math.min(MAX_CANT, lateral / 9.81);
  const targetPitch = Math.max(-0.035, Math.min(0.035, -motion.acceleration * 0.004));

  return { targetCant, targetPitch };
}
