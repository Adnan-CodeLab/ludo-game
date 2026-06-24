// Custom Ludo game logic — pure functions, server-authoritative.

export const COLORS = ['red', 'green', 'yellow', 'blue'];

// Standard 52-square ludo main track. Start indices per color.
export const START_INDEX = { red: 0, green: 13, yellow: 26, blue: 39 };

// Safe squares: starting square of each color + 4 star squares.
export const SAFE_SQUARES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

// Path length: 51 steps on main track (start = step 0, last main square = step 51),
// then home lane steps 52..56 (5 lane squares) + step 57 = final home.
// We'll use: stepsTaken 0..51 = main, 52..56 = home lane (indices 0..4), 57 = finished.
export const FINISH_STEP = 57;
export const HOME_LANE_ENTER = 52;

export function newToken() {
  return { steps: 0, finished: false };
}

export function newPlayerState(color) {
  return {
    color,
    tokens: [newToken(), newToken(), newToken(), newToken()],
  };
}

// Absolute board square for a token on the main track, or null if in home lane/finished.
export function mainSquare(color, steps) {
  if (steps >= HOME_LANE_ENTER) return null;
  return (START_INDEX[color] + steps) % 52;
}

export function tokensInHomeLane(player) {
  return player.tokens.filter(t => !t.finished && t.steps >= HOME_LANE_ENTER).length;
}

export function allFinished(player) {
  return player.tokens.every(t => t.finished);
}

// How many dice this player rolls this turn.
export function diceCountFor(player) {
  const inLane = tokensInHomeLane(player);
  return inLane >= 3 ? 1 : 2;
}

export function rollDice(count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(1 + Math.floor(Math.random() * 6));
  return out;
}

// Validate a single token move by `steps` count.
// Returns { ok, newSteps, capture: {color,tokenIdx}|null } or { ok:false, reason }.
export function simulateMove(state, color, tokenIdx, stepsToMove) {
  const player = state.players[color];
  if (!player) return { ok: false, reason: 'no-player' };
  const tok = player.tokens[tokenIdx];
  if (!tok) return { ok: false, reason: 'no-token' };
  if (tok.finished) return { ok: false, reason: 'finished' };

  const target = tok.steps + stepsToMove;
  if (target > FINISH_STEP) return { ok: false, reason: 'overshoot' };

  let capture = null;
  // Capture only possible when landing on a main-track square.
  if (target < HOME_LANE_ENTER) {
    const square = (START_INDEX[color] + target) % 52;
    if (!SAFE_SQUARES.has(square)) {
      for (const oc of COLORS) {
        if (oc === color) continue;
        const op = state.players[oc];
        if (!op) continue;
        for (let i = 0; i < op.tokens.length; i++) {
          const ot = op.tokens[i];
          if (ot.finished) continue;
          if (mainSquare(oc, ot.steps) === square) {
            capture = { color: oc, tokenIdx: i };
            break;
          }
        }
        if (capture) break;
      }
    }
  }

  return { ok: true, newSteps: target, capture, finished: target === FINISH_STEP };
}

// Generate all "plans" for the current dice. A plan is an ordered list of moves
// using each die exactly once (or a single combined move using both dice on one token).
// Returns array of { moves: [{tokenIdx, die, steps}], capturesCount }.
export function enumeratePlans(state, color, dice) {
  const plans = [];
  const player = state.players[color];

  function tryApply(stateSnapshot, tokenIdx, steps) {
    const sim = simulateMoveOnSnapshot(stateSnapshot, color, tokenIdx, steps);
    return sim;
  }

  if (dice.length === 1) {
    const d = dice[0];
    for (let i = 0; i < 4; i++) {
      const sim = simulateMove(state, color, i, d);
      if (sim.ok) {
        plans.push({
          moves: [{ tokenIdx: i, die: d, steps: d }],
          capturesCount: sim.capture ? 1 : 0,
        });
      }
    }
    return plans;
  }

  // Two dice. Options:
  //  A) Use each die on possibly different tokens, in either order.
  //  B) Combine both dice on one token (single move of d1+d2).
  const [d1, d2] = dice;

  // Combined move on a single token.
  for (let i = 0; i < 4; i++) {
    const sim = simulateMove(state, color, i, d1 + d2);
    if (sim.ok) {
      plans.push({
        moves: [{ tokenIdx: i, die: d1 + d2, steps: d1 + d2, combined: true }],
        capturesCount: sim.capture ? 1 : 0,
      });
    }
  }

  // Sequential: try every (firstDie, firstToken) then (secondDie, secondToken).
  const orders = d1 === d2 ? [[d1, d2]] : [[d1, d2], [d2, d1]];
  for (const [a, b] of orders) {
    for (let i = 0; i < 4; i++) {
      const sim1 = simulateMove(state, color, i, a);
      if (!sim1.ok) continue;
      const snap = applyMoveToSnapshot(cloneState(state), color, i, sim1);
      let anySecond = false;
      for (let j = 0; j < 4; j++) {
        const sim2 = simulateMoveOnSnapshot(snap, color, j, b);
        if (!sim2.ok) continue;
        anySecond = true;
        plans.push({
          moves: [
            { tokenIdx: i, die: a, steps: a },
            { tokenIdx: j, die: b, steps: b },
          ],
          capturesCount: (sim1.capture ? 1 : 0) + (sim2.capture ? 1 : 0),
        });
      }
      if (!anySecond) {
        // Allow using only first die if second die has no legal move.
        plans.push({
          moves: [
            { tokenIdx: i, die: a, steps: a },
            { tokenIdx: -1, die: b, steps: 0, skipped: true },
          ],
          capturesCount: sim1.capture ? 1 : 0,
        });
      }
    }
  }

  // If nothing at all is possible, return empty (turn passes).
  return plans;
}

export function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function simulateMoveOnSnapshot(state, color, tokenIdx, steps) {
  return simulateMove(state, color, tokenIdx, steps);
}

export function applyMoveToSnapshot(state, color, tokenIdx, sim) {
  const tok = state.players[color].tokens[tokenIdx];
  tok.steps = sim.newSteps;
  if (sim.finished) tok.finished = true;
  if (sim.capture) {
    const ct = state.players[sim.capture.color].tokens[sim.capture.tokenIdx];
    ct.steps = 0;
    ct.finished = false;
  }
  return state;
}

// Mandatory kill check: given the chosen plan, is there another plan with more captures?
export function violatesMandatoryKill(plans, chosenPlan) {
  const maxCaptures = plans.reduce((m, p) => Math.max(m, p.capturesCount), 0);
  return chosenPlan.capturesCount < maxCaptures;
}

// Find the "guilty" token — the one that COULD have captured but wasn't used.
// We return the tokenIdx that appears in the highest-capturing plan's first capturing move.
export function findGuiltyToken(state, color, plans) {
  const maxCaptures = plans.reduce((m, p) => Math.max(m, p.capturesCount), 0);
  if (maxCaptures === 0) return null;
  for (const p of plans) {
    if (p.capturesCount !== maxCaptures) continue;
    // Walk the plan and find the move that produced a capture.
    const snap = cloneState(state);
    for (const m of p.moves) {
      if (m.skipped) continue;
      const sim = simulateMoveOnSnapshot(snap, color, m.tokenIdx, m.steps);
      if (sim.ok && sim.capture) return m.tokenIdx;
      if (sim.ok) applyMoveToSnapshot(snap, color, m.tokenIdx, sim);
    }
  }
  return null;
}