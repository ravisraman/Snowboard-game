/**
 * Close-up captures of the rider, in the poses that matter.
 *
 * The mechanics harness can prove the rig does not fall apart, but nothing
 * automated can tell you whether the character *looks* good — so this drives
 * the rider into a handful of poses, parks a camera two metres away, and
 * leaves the pictures somewhere they can be looked at.
 *
 *   npm run dev                       # in another shell
 *   node tools/rider-shots.mjs /tmp/shots
 */
import { chromium } from 'playwright';

const OUT = process.argv[2] ?? '/tmp/shots';
const URL = process.env.GAME_URL ?? 'http://localhost:5173/';

const launchOptions = { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] };
if (process.env.CHROMIUM_PATH) launchOptions.executablePath = process.env.CHROMIUM_PATH;

const browser = await chromium.launch(launchOptions);
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE:', m.text()); });

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.game, null, { timeout: 90000 });

// The title screen blurs the canvas behind it, which is exactly the wrong
// thing when the canvas is the subject. Drop the overlay and the blur.
await page.addStyleTag({ content: '#overlay,#hud,#loading,.corner-buttons{display:none!important} #scene{filter:none!important}' });

// Take the frame loop away from the page, or the chase camera puts itself back
// behind the rider between posing them and taking the picture.
await page.evaluate(() => window.game.renderer.setAnimationLoop(null));

/**
 * Rides for a while under `settle`, then holds `pose` for a moment and frames
 * the rider from `dir` — a direction in metres relative to the board.
 */
async function shot(name, opts) {
  await page.evaluate(({ settleFor, pose, holdFor, dir, at }) => {
    const g = window.game;
    const r = g.rider;
    const NONE = { steer: 0, tuck: false, brake: false, press: false, jumpPressed: false, grabType: null };
    const dt = 1 / 120;

    r.reset();
    r.position.set(g.course.centerX(600), 0, 600);
    r.yaw = g.course.trackHeading(600);
    r.speed = 20;
    r.settle();
    for (let i = 0; i < settleFor * 120; i++) r.update(dt, { ...NONE, ...(pose.while ?? {}) });
    for (let i = 0; i < holdFor * 120; i++) r.update(dt, { ...NONE, ...pose });

    const cam = g.camera;
    cam.position.set(r.position.x + dir[0], r.position.y + dir[1], r.position.z + dir[2]);
    cam.lookAt(r.position.x, r.position.y + (at ?? 0.8), r.position.z);
    cam.updateMatrixWorld();
    g.renderer.render(g.scene, g.camera);
  }, {
    settleFor: opts.settleFor ?? 1.5,
    holdFor: opts.holdFor ?? 0.6,
    pose: opts.pose ?? {},
    dir: opts.dir ?? [2.2, 0.9, 1.4],
    at: opts.at,
  });
  await page.screenshot({ path: `${OUT}/rider-${name}.png` });
  console.log('captured', name);
}

await shot('front', { dir: [2.3, 0.6, 0.6] });
await shot('side', { dir: [0.4, 0.7, 2.6] });
await shot('back', { dir: [-2.3, 0.7, -0.5] });
await shot('carve', { pose: { steer: 1 }, holdFor: 1.6, dir: [2.0, 1.0, 1.8] });
await shot('tuck', { pose: { tuck: true }, holdFor: 1.2, dir: [1.6, 0.7, 2.2] });
await shot('air', { pose: { jumpPressed: true }, holdFor: 0.35, dir: [2.4, 0.9, 1.2] });
await shot('grab', { pose: { jumpPressed: true, grabType: 'method' }, holdFor: 0.5, dir: [2.4, 0.7, 1.6] });
await shot('head', { dir: [1.1, 0.35, 0.5], at: 1.35 });

await browser.close();
