# Alpine Carve

A downhill snowboarding game in Three.js. Drop in at the top of an alpine
resort, carve a groomed piste through the pines, hit the kickers, and make the
village at the bottom without putting yourself into a tree.

```bash
npm install
npm run dev      # http://localhost:5173
```

| Key | |
| --- | --- |
| <kbd>A</kbd> / <kbd>D</kbd> | Carve onto the heel or toe edge |
| <kbd>W</kbd> | Tuck for speed |
| <kbd>S</kbd> | Brake and slide |
| <kbd>Space</kbd> | Ollie |
| <kbd>R</kbd> | Restart |

Arrow keys work too. Your best time is kept in `localStorage`.

## What's here

Everything is generated at runtime — there are no downloaded models, textures
or sound files. The trees, peaks, chalets, corduroy and snow spray are all
built from primitives and shaders at startup, which keeps the whole thing to a
single dependency and a couple of hundred kilobytes.

A few of those generators are doing more than they look like they are, and the
notes below cover the parts that are easy to get subtly wrong.

```
src/
  main.js                 renderer, frame loop, window plumbing
  core/
    Game.js               world assembly, state machine, hazards
    ChaseCamera.js        third-person chase cam
    Input.js              keyboard
    HUD.js                speed, timer, overlays
    mathx.js              seeded RNG, damping, value noise
  world/
    Course.js             the height field everything else reads
    Terrain.js            slope mesh + corduroy/powder shader
    Kickers.js            ramp meshes
    Trees.js              instanced snowy pines
    Village.js            chalets, church, finish gate
    Environment.js        sky, mountain panorama, lighting
  entities/
    Rider.js              snowboarder model + ride physics
    Skiers.js             drifting NPC skiers
  fx/
    SnowSpray.js          carve plume particles
tools/
  check-mechanics.mjs     headless smoke test for the ride model
```

## How the ride model works

Steering tips the rider onto an edge, and the edge angle is driven by a spring,
so a turn has weight — you commit to it rather than flicking between edges.

Edge angle becomes **curvature**, not a turn rate. The board follows an arc of
a roughly fixed radius (~15 m at full edge) and the resulting yaw rate is
`speed × curvature`, exactly like a real board's sidecut: the faster you go,
the faster the same edge angle swings you round. Holding the arc scrubs speed
in proportion to how hard you're carving, so the quickest line down is the
straightest one you can get away with. Off the corduroy, powder multiplies drag
by an order of magnitude and takes most of your edge grip with it.

Vertically there is one rule, and jumps fall out of it rather than being
special-cased. While the board is on the snow its vertical velocity is
whatever the surface dictates — but snow can push you up and never pull you
down faster than gravity. The moment those two disagree by more than a small
separation speed, you're in the air. That single rule is a kicker's lip, a
rollover, and going light over a roll, all at once. Landing projects the
velocity back onto the slope: the component running along the surface is kept,
which is why landing a steep transition gives your speed back, and the
component driven into the snow is the impact, which is the only part that costs
you.

Two details in there are load-bearing and easy to get wrong:

- The slope under the board is sampled **behind** the rider only. A sample that
  spans a kicker's lip reads as a near-vertical dive and throws the rider at
  the ground instead of into the air.
- Leaving the ground is decided on **separation speed**, not on clearing some
  distance in a frame. Anything distance-based flickers the rider on and off
  the snow every time the pitch steepens, which silently cancels the friction,
  the spray and the powder drag along with it.

## The world

`Course.js` is the single source of truth for the shape of the mountain — the
fall line, the winding centre line of the piste, the kicker ramps and the
powder. The terrain mesh, the tree scatter, the skiers and the rider's own
collision all read the same analytic height field, so the visuals and the
physics cannot drift apart.

### Snow

Groomed corduroy is white, not blue — the blue in a photograph of a piste is
sky reflecting off it and shadow inside each groove. So the grooming is bumped
into the surface *normal* rather than painted into the colour: a few thousand
30 cm ridges catching the sun down one flank and shading down the other, faded
out in the shader once a ridge gets finer than a pixel. Painting it as stripes
instead gives you a blue rug.

The pines follow the same principle in reverse. They are snow first and green
second: each whorl of branches is covered by a scalloped white drape that is
deliberately *blunter* than the cone beneath it, so it stands proud through the
middle of the tier and piles over the apex while the green survives as a fringe
at the bottom rim. A drape sharing the whorl's taper is uniformly scaled
against it and either buries the tree or vanishes inside it.

The mountain panorama is drawn unlit, with the sun, the conifer band and the
aerial haze all baked into its vertex colours. The fill light the foreground
snow needs is far too much for a peak four kilometres away, and no single
lighting setup serves both. Shaded faces shift toward blue rather than just
darkening, which is what stops the ranges reading as grey pyramids.

### Terrain layout

The slope mesh is laid out in *track space*: rows of vertices run perpendicular
to the piste's tangent and columns are packed tightly across the groomer and
spread out into the powder, so the corduroy stays crisp where the rider is
without paying for fine triangles a hundred metres out in the trees. Further
out the grid relaxes back into world space — the perpendicular sweep folds over
itself wherever the track's radius of curvature is tighter than the offset. The
corduroy itself is drawn in the shader from the across-track coordinate, so the
grooming lines follow every bend exactly.

The slope and the forest are both sliced along the course so the renderer can
frustum-cull them. As single meshes they are hundreds of thousands of triangles
drawn every frame — and again for the shadow pass — when only a fraction is
ever on screen.

## Checks

`tools/check-mechanics.mjs` boots the game headless, takes over the frame loop
so simulated time is independent of render speed, and asserts the properties
that make the game playable: carve radius and turn rate, powder actually
costing speed, every kicker on the course launching, and the run being
completable in a sane time.

```bash
npm run dev        # in one shell
npm run check      # in another
```

It needs Playwright's Chromium (`npx playwright install chromium`), or set
`CHROMIUM_PATH` to an existing binary. The check drives `window.game`, which
the dev build exposes and production builds do not.
