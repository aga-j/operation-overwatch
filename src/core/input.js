// Centralised input state. Pointer-lock mouse deltas are accumulated and
// consumed once per frame by the player controller.
// `demoMode` lets a headless playtest drive mouse-look without pointer lock.
// Round 11 — mouse-look spike rejection.
//
// Chrome's Pointer Lock implementation emits bogus `movementX/Y` values in two
// situations: the first event or two right after the lock is acquired (it
// reports the delta from the OS cursor's old screen position — often 1000+ px),
// and occasionally after the window regains focus. Feeding those straight into
// yaw produced the "sometimes the view suddenly whips past where I aimed" bug.
//
// A human at any realistic polling rate (125-1000 Hz) never produces more than
// ~150 px in a single event, so anything past this threshold is an artifact.
const MAX_EVENT_DELTA = 400;
// Number of mousemove events to swallow immediately after a lock is acquired.
const LOCK_SETTLE_EVENTS = 2;

export function createInput(demoMode = false) {
  const state = {
    keys: Object.create(null),
    mouseDX: 0,
    mouseDY: 0,
    fireDown: false,
    reloadQueued: false,
    jumpQueued: false,
    sprint: false,
    // Diagnostics the QA harness reads back — a non-zero spike count on a
    // clean run means the filter is earning its keep (or misfiring).
    lookSpikes: 0,
    lookSwallowed: 0,
  };

  let settleLeft = 0;

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    state.keys[e.code] = true;
    if (e.code === 'KeyR') state.reloadQueued = true;
    if (e.code === 'Space') state.jumpQueued = true;
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') state.sprint = true;
  });

  window.addEventListener('keyup', (e) => {
    state.keys[e.code] = false;
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') state.sprint = false;
  });

  window.addEventListener('mousedown', (e) => {
    if (e.button === 0) state.fireDown = true;
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) state.fireDown = false;
  });
  window.addEventListener('blur', () => {
    state.fireDown = false;
    state.keys = Object.create(null);
    state.sprint = false;
  });

  // Acquiring pointer lock (and regaining focus while locked) is when Chrome
  // emits its garbage deltas — arm the settle window on both.
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement) settleLeft = LOCK_SETTLE_EVENTS;
  });
  window.addEventListener('focus', () => {
    if (document.pointerLockElement) settleLeft = LOCK_SETTLE_EVENTS;
  });

  window.addEventListener('mousemove', (e) => {
    if (!(document.pointerLockElement || demoMode)) return;

    // Swallow the first couple of events after a (re)lock outright.
    if (settleLeft > 0) {
      settleLeft--;
      state.lookSwallowed++;
      return;
    }

    const mx = e.movementX;
    const my = e.movementY;
    // Physically impossible for a human in one event -> browser artifact.
    if (Math.abs(mx) > MAX_EVENT_DELTA || Math.abs(my) > MAX_EVENT_DELTA) {
      state.lookSpikes++;
      return;
    }

    state.mouseDX += mx;
    state.mouseDY += my;
  });

  if (demoMode) window.__input = state;
  return state;
}
