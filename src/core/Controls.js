/**
 * Every control and every trick, in one table.
 *
 * The title screen, the pause panel and the phone's button labels all render
 * from this, so a new trick is one row here rather than three edits in three
 * files that quietly drift apart. `keys` is the desktop binding and `touch` is
 * the on-screen equivalent; a row with no `touch` simply doesn't appear in the
 * phone list, which is how the two schemes are allowed to differ without the
 * player ever being told something untrue.
 */

export const CONTROL_GROUPS = [
  {
    title: 'Riding',
    rows: [
      { keys: ['A', 'D'], touch: 'Drag', label: 'Carve onto the heel or toe edge' },
      { keys: ['W'], touch: 'TUCK', label: 'Tuck for speed' },
      { keys: ['S'], touch: 'BRAKE', label: 'Brake and slide' },
      { keys: ['Space'], touch: 'OLLIE', label: 'Ollie — pop off the kickers' },
    ],
  },
  {
    title: 'In the air',
    rows: [
      { keys: ['A', 'D'], touch: 'Drag', label: 'Spin the board — let go once first to arm it' },
      { keys: ['S'], touch: 'GRAB', label: 'Grab the board — let go before you land' },
    ],
  },
  {
    title: 'When it goes wrong',
    rows: [
      { keys: ['E'], touch: 'Prompt', label: 'Drop back onto the piste, once you are bogged down' },
      { keys: ['R'], touch: 'Prompt', label: 'Restart the run, at any time' },
      { keys: ['Esc'], touch: '?', label: 'Pause, and bring this list back up' },
    ],
  },
];

/**
 * What pays, and roughly how much. Deliberately vague about the exact numbers —
 * the point is to tell you what the game is looking for, not to be a spec.
 */
export const TRICK_GUIDE = [
  { name: 'Air', detail: 'Every second off the snow' },
  { name: 'Spin', detail: 'Each 180 pays more than the last — a 720 beats two 360s' },
  { name: 'Grab', detail: 'By how long you hold it' },
  { name: 'Clean landing', detail: 'Straight or switch, both count — and only this banks the multiplier' },
  { name: 'Close one', detail: 'Threading a tree at speed' },
  { name: 'Powder turn', detail: 'A committed carve off the groomer' },
];

export const SCORING_NOTE =
  'The multiplier climbs with every clean landing and slides back if you do ' +
  'nothing with it. Crashing takes the multiplier — the points you have ' +
  'already landed are yours to keep.';
