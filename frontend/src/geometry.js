export const INCH = 1;

export function hypot(dx, dy) {
  return Math.hypot(dx, dy);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function wallLength(wall) {
  return hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
}

export function wallDir(wall) {
  const len = wallLength(wall) || 1;
  return {
    x: (wall.x2 - wall.x1) / len,
    y: (wall.y2 - wall.y1) / len,
  };
}

/** Unit normal pointing to the left of the wall direction. */
export function wallLeftNormal(wall) {
  const d = wallDir(wall);
  return { x: -d.y, y: d.x };
}

/** Vector representing wall thickness displacement from baseline. */
export function wallThickVector(wall) {
  const n = wallLeftNormal(wall);
  const side = wall.side === 1 ? 1 : -1;
  return { x: n.x * wall.thickness * side, y: n.y * wall.thickness * side };
}

function computeMiter(P, d1, T1, d2, T2, maxExt) {
  const P1 = { x: P.x + T1.x, y: P.y + T1.y };
  const P2 = { x: P.x + T2.x, y: P.y + T2.y };
  const det = d2.x * d1.y - d1.x * d2.y;
  if (Math.abs(det) < 0.01) return P1;
  const diffX = P2.x - P1.x;
  const diffY = P2.y - P1.y;
  const t = (diffX * (-d2.y) - diffY * (-d2.x)) / det;
  const inter = { x: P1.x + t * d1.x, y: P1.y + t * d1.y };
  if (hypot(inter.x - P.x, inter.y - P.y) > maxExt) return P1;
  return inter;
}

function findConnectedWall(point, currentWall, walls) {
  for (const other of walls) {
    if (other.id === currentWall.id) continue;
    if (hypot(other.x1 - point.x, other.y1 - point.y) < 0.5) {
      return { wall: other, at: "start" };
    }
    if (hypot(other.x2 - point.x, other.y2 - point.y) < 0.5) {
      return { wall: other, at: "end" };
    }
  }
  return null;
}

export function wallPolygon(wall, walls = []) {
  const d = wallDir(wall);
  if (wall.side === 0) {
    const nx = -d.y * (wall.thickness / 2);
    const ny = d.x * (wall.thickness / 2);
    return [
      { x: wall.x1 + nx, y: wall.y1 + ny },
      { x: wall.x2 + nx, y: wall.y2 + ny },
      { x: wall.x2 - nx, y: wall.y2 - ny },
      { x: wall.x1 - nx, y: wall.y1 - ny },
    ];
  }

  const T = wallThickVector(wall);
  const S = { x: wall.x1, y: wall.y1 };
  const E = { x: wall.x2, y: wall.y2 };
  let S_out = { x: S.x + T.x, y: S.y + T.y };
  let E_out = { x: E.x + T.x, y: E.y + T.y };

  if (walls && walls.length > 0) {
    const maxExt = 2.5 * wall.thickness;
    const connEnd = findConnectedWall(E, wall, walls);
    if (connEnd) {
      const other = connEnd.wall;
      if (other.side !== 0) {
        const d_other = wallDir(other);
        const T_other = wallThickVector(other);
        E_out = computeMiter(E, d, T, d_other, T_other, maxExt);
      }
    }
    const connStart = findConnectedWall(S, wall, walls);
    if (connStart) {
      const other = connStart.wall;
      if (other.side !== 0) {
        const d_other = wallDir(other);
        const T_other = wallThickVector(other);
        S_out = computeMiter(S, d, T, d_other, T_other, maxExt);
      }
    }
  }

  return [S, E, E_out, S_out];
}

export function wallCorners(wall, walls = []) {
  return wallPolygon(wall, walls);
}

export function pointsToPath(points) {
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`)
    .join(" ") + " Z";
}

export function projectOnWall(point, wall) {
  const dx = wall.x2 - wall.x1;
  const dy = wall.y2 - wall.y1;
  const len = hypot(dx, dy) || 1;
  const tRaw = ((point.x - wall.x1) * dx + (point.y - wall.y1) * dy) / (len * len);
  const t = clamp(tRaw, 0, 1);
  const px = wall.x1 + dx * t;
  const py = wall.y1 + dy * t;
  const cross = dx * (point.y - wall.y1) - dy * (point.x - wall.x1);
  const side = cross >= 0 ? 1 : -1;

  let dist = hypot(point.x - px, point.y - py);
  if (wall.side !== 0) {
    const wallSide = wall.side === 1 ? 1 : -1;
    if (side === wallSide) {
      dist = Math.max(0, dist - wall.thickness);
    }
  }

  return { t, along: t * len, point: { x: px, y: py }, dist, side };
}

export function nearestWall(point, walls) {
  let best = null;
  for (const wall of walls) {
    const hit = projectOnWall(point, wall);
    if (!best || hit.dist < best.dist) {
      best = { wall, ...hit };
    }
  }
  return best;
}

export function cabinetCorners(cabinet, walls) {
  const wall = walls.find((w) => w.id === cabinet.wallId);
  const halfW = cabinet.width / 2;
  const depth = cabinet.depth;

  if (!wall) {
    const cx = cabinet.x;
    const cy = cabinet.y;
    const rot = cabinet.rotation || 0;
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const along = { x: c, y: s };
    const intoRoom = { x: -s, y: c };
    const back = { x: cx, y: cy };
    return cornersFromFrame(back, along, intoRoom, halfW, depth);
  }

  const along = wallDir(wall);
  const n = wallLeftNormal(wall);
  const intoRoom = { x: n.x * cabinet.side, y: n.y * cabinet.side };

  let backOffset = 0;
  if (wall.side === 0) {
    backOffset = wall.thickness / 2;
  } else {
    const wallSide = wall.side === 1 ? 1 : -1;
    if (cabinet.side === wallSide) {
      backOffset = wall.thickness;
    } else {
      backOffset = 0;
    }
  }

  const back = {
    x: wall.x1 + along.x * cabinet.along + n.x * (cabinet.side * backOffset),
    y: wall.y1 + along.y * cabinet.along + n.y * (cabinet.side * backOffset),
  };
  return cornersFromFrame(back, along, intoRoom, halfW, depth);
}

function cornersFromFrame(back, along, intoRoom, halfW, depth) {
  const bl = {
    x: back.x - along.x * halfW,
    y: back.y - along.y * halfW,
  };
  const br = {
    x: back.x + along.x * halfW,
    y: back.y + along.y * halfW,
  };
  const fl = {
    x: bl.x + intoRoom.x * depth,
    y: bl.y + intoRoom.y * depth,
  };
  const fr = {
    x: br.x + intoRoom.x * depth,
    y: br.y + intoRoom.y * depth,
  };
  return { bl, br, fl, fr, back };
}

export function cabinetPolygon(cabinet, walls) {
  const { bl, br, fr, fl } = cabinetCorners(cabinet, walls);
  return [bl, br, fr, fl];
}

export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const intersect =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || 1e-9) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function orthoEnd(start, end, freeAngle) {
  if (freeAngle) return { ...end };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return { x: end.x, y: start.y };
  }
  return { x: start.x, y: end.y };
}

export function snapToGrid(point, size) {
  return {
    x: Math.round(point.x / size) * size,
    y: Math.round(point.y / size) * size,
  };
}

export function wallEndpoints(wall) {
  return [
    { x: wall.x1, y: wall.y1 },
    { x: wall.x2, y: wall.y2 },
  ];
}

export function nearestWallCorner(point, walls, maxDist) {
  let best = null;
  for (const wall of walls) {
    const corners = wallCorners(wall, walls);
    for (let i = 0; i < corners.length; i++) {
      const corner = corners[i];
      const dist = hypot(point.x - corner.x, point.y - corner.y);
      if (dist <= maxDist && (!best || dist < best.dist)) {
        best = { x: corner.x, y: corner.y, dist, wallId: wall.id, cornerIndex: i };
      }
    }
  }
  return best;
}

export function autoWallSide(start, end, thickness, walls) {
  const len = hypot(end.x - start.x, end.y - start.y);
  if (len < 0.5) return null;
  const d = { x: (end.x - start.x) / len, y: (end.y - start.y) / len };
  const n = { x: -d.y, y: d.x };
  const sampleLen = Math.min(len * 0.5, 4);

  const ptMinus = {
    x: start.x + d.x * sampleLen + n.x * (-1 * thickness * 0.5),
    y: start.y + d.y * sampleLen + n.y * (-1 * thickness * 0.5),
  };
  const ptPlus = {
    x: start.x + d.x * sampleLen + n.x * (1 * thickness * 0.5),
    y: start.y + d.y * sampleLen + n.y * (1 * thickness * 0.5),
  };

  let overlapMinus = false;
  let overlapPlus = false;
  for (const w of walls) {
    const poly = wallPolygon(w, walls);
    if (pointInPolygon(ptMinus, poly)) overlapMinus = true;
    if (pointInPolygon(ptPlus, poly)) overlapPlus = true;
  }

  if (overlapMinus && !overlapPlus) return 1;
  if (overlapPlus && !overlapMinus) return -1;
  return null;
}

export function snapWallPoint(raw, walls, options = {}) {
  const {
    gridSize = 12,
    cornerDist = 12,
    start = null,
    freeAngle = false,
  } = options;

  const aligned = start ? orthoEnd(start, raw, freeAngle) : raw;
  const cornerA = nearestWallCorner(raw, walls, cornerDist);
  const cornerB = nearestWallCorner(aligned, walls, cornerDist);
  const corner = !cornerA ? cornerB : !cornerB ? cornerA : cornerA.dist <= cornerB.dist ? cornerA : cornerB;
  if (corner) {
    return { x: corner.x, y: corner.y, kind: "corner", wallId: corner.wallId };
  }

  if (!start) {
    const grid = snapToGrid(raw, gridSize);
    return { ...grid, kind: "grid" };
  }

  if (freeAngle) {
    const grid = snapToGrid(aligned, gridSize);
    return { ...grid, kind: "grid" };
  }

  if (aligned.y === start.y) {
    return { x: Math.round(aligned.x / gridSize) * gridSize, y: start.y, kind: "grid" };
  }
  return { x: start.x, y: Math.round(aligned.y / gridSize) * gridSize, kind: "grid" };
}

export function formatInches(value) {
  const rounded = Math.round(value * 1000) / 1000;
  if (Number.isInteger(rounded)) return `${rounded}"`;
  return `${rounded}"`;
}

function polyCenter(poly) {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return { x: x / poly.length, y: y / poly.length };
}

/** SAT overlap test for convex polygons (cabinets are rectangles).
 *  Returns MTV to push polyA out of polyB. Touching (depth 0) counts as no overlap. */
export function polygonsOverlapSAT(polyA, polyB) {
  let bestOverlap = Infinity;
  let bestAxis = null;
  for (const poly of [polyA, polyB]) {
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i];
      const p2 = poly[(i + 1) % poly.length];
      const ex = p2.x - p1.x;
      const ey = p2.y - p1.y;
      const len = hypot(ex, ey) || 1;
      const axis = { x: -ey / len, y: ex / len };
      let minA = Infinity;
      let maxA = -Infinity;
      let minB = Infinity;
      let maxB = -Infinity;
      for (const p of polyA) {
        const d = p.x * axis.x + p.y * axis.y;
        if (d < minA) minA = d;
        if (d > maxA) maxA = d;
      }
      for (const p of polyB) {
        const d = p.x * axis.x + p.y * axis.y;
        if (d < minB) minB = d;
        if (d > maxB) maxB = d;
      }
      const overlap = Math.min(maxA, maxB) - Math.max(minA, minB);
      if (overlap <= 1e-9) return { overlap: false, depth: 0, nx: 0, ny: 0 };
      if (overlap < bestOverlap) {
        bestOverlap = overlap;
        bestAxis = axis;
      }
    }
  }
  const cA = polyCenter(polyA);
  const cB = polyCenter(polyB);
  if ((cA.x - cB.x) * bestAxis.x + (cA.y - cB.y) * bestAxis.y < 0) {
    bestAxis = { x: -bestAxis.x, y: -bestAxis.y };
  }
  return { overlap: true, depth: bestOverlap, nx: bestAxis.x, ny: bestAxis.y };
}

function pointSegClosest(p, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby || 1e-9;
  const t = clamp(((p.x - a.x) * abx + (p.y - a.y) * aby) / len2, 0, 1);
  const qx = a.x + abx * t;
  const qy = a.y + aby * t;
  return { dist: hypot(p.x - qx, p.y - qy), qx, qy };
}

/** Minimal translation to move polyA into contact with polyB (assumes no overlap).
 *  Returns gap distance and vector (vx, vy) to apply to polyA. */
export function polygonGapVector(polyA, polyB) {
  let best = { dist: Infinity, vx: 0, vy: 0 };
  for (const p of polyA) {
    for (let i = 0; i < polyB.length; i++) {
      const a = polyB[i];
      const b = polyB[(i + 1) % polyB.length];
      const { dist, qx, qy } = pointSegClosest(p, a, b);
      if (dist < best.dist) best = { dist, vx: qx - p.x, vy: qy - p.y };
    }
  }
  for (const p of polyB) {
    for (let i = 0; i < polyA.length; i++) {
      const a = polyA[i];
      const b = polyA[(i + 1) % polyA.length];
      const { dist, qx, qy } = pointSegClosest(p, a, b);
      if (dist < best.dist) best = { dist, vx: p.x - qx, vy: p.y - qy };
    }
  }
  return best;
}

/** Reassign cabinet ids 1..N in positional order and return old->new map.
 *  Wall-hung cabinets come first (grouped by wall, ordered along the wall's
 *  dominant world axis so the lowest x — or y for vertical walls — is #lowest),
 *  then freestanding cabinets left-to-right, top-to-bottom. */
export function renumberCabinetIds(cabinets, walls) {
  const backOf = (cab) => cabinetCorners(cab, walls).back;
  const sorted = [...cabinets].sort((a, b) => {
    const aw = a.wallId != null ? walls.find((w) => w.id === a.wallId) : null;
    const bw = b.wallId != null ? walls.find((w) => w.id === b.wallId) : null;
    if ((aw != null) !== (bw != null)) return aw != null ? -1 : 1;
    if (aw && bw) {
      if (a.wallId !== b.wallId) return a.wallId - b.wallId;
      const horiz = Math.abs(aw.x2 - aw.x1) >= Math.abs(aw.y2 - aw.y1);
      const pa = backOf(a);
      const pb = backOf(b);
      const ka = horiz ? pa.x : pa.y;
      const kb = horiz ? pb.x : pb.y;
      if (ka !== kb) return ka - kb;
      const ja = horiz ? pa.y : pa.x;
      const jb = horiz ? pb.y : pb.x;
      if (ja !== jb) return ja - jb;
      return a.id - b.id;
    }
    const pa = backOf(a);
    const pb = backOf(b);
    if (pa.x !== pb.x) return pa.x - pb.x;
    if (pa.y !== pb.y) return pa.y - pb.y;
    return a.id - b.id;
  });
  const oldToNew = new Map(sorted.map((cab, i) => [cab.id, i + 1]));
  for (const cab of sorted) cab.id = oldToNew.get(cab.id);
  return oldToNew;
}
