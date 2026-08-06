/**
 * Every control and every trick, in one table.
 *
 * The title screen, the pause panel and the phone's button labels all render
 * from this, so a new trick is one row here rather than three edits in three
 * files that quietly drift apart. `keys` is the binding, `alt` is the same
 * thing for a hand on WASD, and `touch` is the on-screen equivalent; a row with
 * no `touch` simply doesn't appear in the phone list, which is how the two
 * schemes are allowed to differ without the player ever being told something
 * untrue.
 *
 * ---------------------------------------------------------------------------
 * Why the arrows are listed first
 * ---------------------------------------------------------------------------
 * They used to be listed second, or rather not at all: every row said A, D, W,
 * S, and the arrows worked but were nowhere on screen. Anyone playing on the
 * arrows — which is most people who have never played a keyboard game before,
 * and every child — was reading a panel about a keyboard they were not using
 * and had to translate it themselves.
 *
 * So `keys` is now the arrow scheme, and it is *complete*: five keys reach
 * every control and all four grabs. `alt` carries the letters for anyone who
 * prefers them, and both are live at once, which is also how two people share
 * one keyboard.
 */

export const CONTROL_GROUPS = [
  {
    title: 'Riding',
    rows: [
      { keys: ['←', '→'], alt: ['A', 'D'], touch: 'Drag', label: 'Carve onto the heel or toe edge' },
      { keys: ['↑'], alt: ['W'], touch: 'TUCK', label: 'Tuck for speed — and to burn boost, once you have some' },
      { keys: ['↓'], alt: ['S'], touch: 'BRAKE', label: 'Brake and slide' },
      { keys: ['Space'], touch: 'OLLIE', label: 'Ollie — hold to load it, release to pop. Time it at the lip' },
      { keys: ['Shift'], touch: 'BUTTER', label: 'Press the board — then steer to spin it on the snow' },
    ],
  },
  {
    title: 'In the air',
    rows: [
      { keys: ['←', '→'], alt: ['A', 'D'], touch: 'Drag', label: 'Spin the board — on ORIGINAL, let go of the steer once first to arm it' },
      { keys: ['↓'], alt: ['S'], touch: 'INDY', label: 'Indy — the easy one' },
      { keys: ['↑'], alt: ['W'], touch: 'NOSE', label: 'Nose grab' },
      // The two that used to be marooned on Q and F. Shift is the modifier and
      // it is the same key as BUTTER, which is the point: one extra key, and
      // the grabs you already know how to reach become two more.
      { keys: ['Shift', '↓'], alt: ['Q'], touch: 'BUTTER + BRAKE', label: 'Melon' },
      { keys: ['Shift', '↑'], alt: ['F'], touch: 'BUTTER + TUCK', label: 'Method — worth the most, and the hardest to hold' },
    ],
  },
  {
    title: 'When it goes wrong',
    rows: [
      { keys: ['Backspace'], alt: ['E'], touch: 'Prompt', label: 'Drop back onto the piste, once you are bogged down' },
      // No `keys`: a note rather than a binding. The panel renders these
      // without a key cap — see `_buildHelp`.
      { touch: '—', label: 'Three wipeouts a run — go down a fourth time and it is over' },
      { keys: ['Enter'], alt: ['R'], touch: 'Prompt', label: 'Restart the run, at any time' },
      { keys: ['Esc'], touch: '?', label: 'Pause, and bring this list back up' },
    ],
  },
];

/**
 * What pays, and roughly how much. Deliberately vague about the exact numbers —
 * the point is to tell you what the game is looking for, not to be a spec.
 */
export const TRICK_GUIDE = [
  { name: 'Air', detail: 'Every second off the snow — but only as part of a trick. A straight hop pays nothing' },
  { name: 'Spin', detail: 'Each 180 pays more than the last — a 720 beats two 360s' },
  { name: 'Grab', detail: 'By how long you hold it, and how awkward it is: method beats melon beats nose beats indy' },
  { name: 'Shifty', detail: 'Spin out and bring it back before you land' },
  { name: 'Pop', detail: 'Ollie in the last stretch of a ramp instead of coasting off it' },
  { name: 'Butter', detail: 'A ground spin for the empty stretches — keeps the multiplier alive, but only air builds it' },
  { name: 'Clean landing', detail: 'Straight or switch, both count — and only this banks the multiplier' },
  { name: 'Stomped', detail: 'Dead straight on touchdown' },
  { name: 'Close one', detail: 'Threading a tree at speed' },
  { name: 'Clipping a skier', detail: 'Costs you the speed and the multiplier — but not the run. Only trees end it' },
  { name: 'Powder turn', detail: 'A committed carve off the groomer' },
  { name: 'Grind', detail: 'Ride onto a rail or box and hold your line — steer to balance, pop off the end' },
  { name: 'Star', detail: 'Ride through one — no trick needed, and it never costs you anything to miss' },
  { name: 'Gate', detail: 'Thread the poles — a streak of hits pays more each time, a miss just resets it' },
];

export const SCORING_NOTE =
  'The multiplier climbs with every clean landing and slides back if you do ' +
  'nothing with it. Crashing takes the multiplier — the points you have ' +
  'already landed are yours to keep.';
