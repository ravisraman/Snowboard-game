# Alpine Carve

A downhill snowboarding game in Three.js. Drop in at the top of an alpine
resort, carve a groomed piste through the pines, spin off the kickers, and make
the village at the bottom without putting yourself into a tree. The run is
scored, not timed: air, rotation, grabs, clean landings and near misses all pay,
and a combo multiplier climbs while you keep stringing them together.

```bash
npm install
npm run dev      # http://localhost:5173
```

| Key | Touch | |
| --- | --- | --- |
| <kbd>A</kbd> / <kbd>D</kbd> | drag the left thumb | Carve onto the heel or toe edge |
| <kbd>W</kbd> | hold TUCK | Tuck for speed |
| <kbd>S</kbd> | hold BRAKE | Brake and slide |
| <kbd>Space</kbd> | tap OLLIE | Ollie — or skate, when you're barely moving |
| <kbd>E</kbd> | tap the prompt | Drop back onto the piste |
| <kbd>R</kbd> | tap the prompt | Restart the run, at any time |

Arrow keys work too. In the air, carve left or right to spin and hold brake to
grab. Your best score and best time are both kept in `localStorage`.

## Tricks and scoring

Off a lip the board's heading comes apart from the direction you're travelling:
you keep flying the way you were going, and the steering now spins the board
instead of turning the flight path. A spin has to be *asked for*, though —
carrying a carve through the lip is ordinary riding, and if a held edge kept
rotating the board in the air every kicker would fling you into an unasked-for
360 and wash you out on the other side. Let go of the steering once after
take-off and the spin arms.

Landing is judged on the angle between the board and where you're going, folded
into a quarter turn so riding away switch counts as clean. Within about 40° you
ride away and bank the trick; past that the edge starts to catch and scrubs
speed; past 70° you're down. Air time, each 180 of rotation (escalating), grab
duration, the clean landing itself, near misses and hard powder turns all
score, and each banked trick steps the multiplier. Crashing takes the
multiplier but keeps the points already banked, which is the whole risk.

## Sound

There are no audio files. Everything is synthesised from one buffer of white
noise and a few oscillators, which is a good fit for the subject: almost
everything a snowboard makes *is* filtered noise. The edge is a bandpass whose
centre frequency and gain ride the carve and the speed, dropped an octave and
rolled off in powder; wind is the same noise smeared through a lowpass, rising
with the square of speed. The impacts, the ollie pop and the rising chime as
the combo climbs are short transients on top. The mute button is in the corner
and persists.

The one non-obvious constraint: the `AudioContext` is created inside the DROP
IN click handler. iOS Safari will not start audio outside a real gesture, and a
context created anywhere else stays suspended forever without an error to tell
you so.

## Tracks

The board leaves a trench: a ribbon of quads written into a ring buffer, two
vertices per sample at the board's edges, wrapping round and overwriting the
oldest once it's full. Width and colour follow the carve — narrow and sharp on
the corduroy, wide and soft off-piste.

Rendering tracks into an orthographic texture over the terrain is what you'd
reach for if the whole mountain had to remember them. It doesn't; the chase
camera never sees more than about 150 m behind. The ring buffer needs one
trick, though — the wrap point would otherwise draw a quad stretching from the
newest position back to the oldest, a stripe right across the mountain.
Degenerate quads at the seam solve it, and the same mechanism handles leaving
the ground: the ribbon stops and restarts rather than bridging the gap.

## Phones

On a touch device the game swaps to on-screen controls and a lighter quality
tier automatically; append `?quality=mobile` or `?quality=desktop` to override.
Landscape is the better view, but portrait plays fine.

Steering is a *relative* drag: wherever your left thumb lands becomes the
centre, and the offset from there is the edge angle. On a screen with no rim
to feel for, an absolute stick means hunting for a target you can't see under
your own thumb. The origin is sticky too, so flipping from a hard left carve
to a hard right one is one thumb-width of travel rather than a trip back
across the pad. Unlike the keyboard's ±1, touch steering is analog — the
edge-angle spring reads the in-between values happily.

The mobile tier cuts in cost order: pixels first (a handset renders at 3x
device pixel ratio, nine times the fragment work of 1x), then the shadow pass,
then geometry. The camera also adapts — a phone held upright is a tall, narrow
window, and since the field of view is vertical, portrait otherwise spends it
all on sky and leaves a horizontal view barely wider than the piste. In
portrait the camera stands further back, widens a little and aims lower.

## Playing without a server

```bash
npm run bundle     # -> dist/alpine-carve.html
```

Since nothing is loaded over the network, the whole game folds into one HTML
file you can open directly, email, or drop on any static host.

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
    TouchControls.js      on-screen stick and buttons
    Score.js              trick scoring and the combo multiplier
    Quality.js            desktop/mobile tiers
    HUD.js                score, speed, timer, overlays
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
    SnowTracks.js         the trench the board leaves behind
    Audio.js              synthesised sound, no files
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

### Getting unstuck

Snow resists by being ploughed out of the way, so the resistance falls away as
the board slows. Modelling it as a constant made deep snow an inescapable dead
end — at 5.85 m/s² it outweighs gravity's pull on *every* gradient the course
has, so a rider who stopped in powder could never start again, on any slope,
however steep. There was a second trap behind it: carving needs speed, so at a
crawl the edge does nothing and a rider stopped facing across the hill could
not turn back down it.

Three things now guarantee a way out, in increasing order of intervention:

- The board can be shuffled round on the spot at low speed, fading out as soon
  as there's enough speed to hold an edge. Gravity then does the rest.
- Below 6 m/s the jump button skates instead of ollieing — a shove down the
  fall line. You can't ollie usefully at walking pace anyway.
- After a few seconds under 2.2 m/s, a prompt offers a drop back onto the
  piste (the clock keeps running, so it costs the run rather than ending it)
  or a restart. Restart is available at any time, mid-run included.

### Airborne

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
costing speed, every kicker on the course launching, the run being completable
in a sane time, a 360 fitting inside a typical air, landings being judged the
way they should be, spinning not bending the flight path, the audio staying
asleep until a real gesture, and the track ribbon wrapping its ring buffer
without NaNs or vertices floating off the snow.

```bash
npm run dev        # in one shell
npm run check      # in another
```

It needs Playwright's Chromium (`npx playwright install chromium`), or set
`CHROMIUM_PATH` to an existing binary. The check drives `window.game`, which
the dev build exposes and production builds do not.
