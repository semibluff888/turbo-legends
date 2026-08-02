/**
 * Compile and warm one online race scene before the caller submits race_loaded.
 * Returning false means the owning load generation expired at an async boundary.
 */
export async function prewarmRaceRenderer({
  renderer,
  scene,
  camera,
  nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve)),
  isCurrent = () => true,
  onStage = () => {},
} = {}) {
  if (!renderer || !scene || !camera) {
    throw new TypeError('renderer, scene, and camera are required');
  }

  onStage('compile');
  if (typeof renderer.compileAsync === 'function') {
    try {
      await renderer.compileAsync(scene, camera);
    } catch {
      if (!isCurrent()) return false;
      renderer.compile?.(scene, camera);
    }
  } else {
    renderer.compile?.(scene, camera);
  }
  if (!isCurrent()) return false;

  onStage('render');
  renderer.render(scene, camera);
  await nextFrame();
  return Boolean(isCurrent());
}
