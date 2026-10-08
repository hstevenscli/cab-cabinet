import "./style.css";
import {
    autoWallSide,
    cabinetCorners,
    cabinetPolygon,
    clamp,
    formatInches,
    nearestWall,
    nearestWallCorner,
    pointInPolygon,
    pointsToPath,
    polygonGapVector,
    polygonsOverlapSAT,
    renumberCabinetIds,
    snapToGrid,
    snapWallPoint,
    wallCorners,
    wallLength,
    wallPolygon,
} from "./geometry.js";

const PX_PER_INCH = 4;
const SNAP_DISTANCE = 12;
const CABINET_SNAP = 2;
const CABINET_OVERLAP_ALLOW = 10;
const GRID_MINOR = 12;
const GRID_MAJOR = 48;
const DEFAULT_WALL = { thickness: 4.5, height: 96, side: -1 };
const DEFAULT_CABINET = { width: 24, depth: 24, height: 34.5 };

const state = {
    tool: "pointer",
    walls: [],
    cabinets: [],
    selected: null,
    drawing: null,
    hover: null,
    dragging: null,
    view: { panX: 48, panY: 48, scale: PX_PER_INCH },
    panning: null,
};

const app = document.querySelector("#app");
app.innerHTML = `
  <div class="shell">
    <aside class="sidebar">
      <header class="brand">
        <div class="brand-mark">CC</div>
        <div>
          <h1>Cabinet-Cad</h1>
          <p>Plan view</p>
        </div>
      </header>

      <section class="panel">
        <h2>Tools</h2>
        <p class="hint">More tools will land here later.</p>
        <div class="tool-list" id="tools"></div>
      </section>

      <section class="panel" id="props-panel">
        <h2>Properties</h2>
        <div id="props"></div>
      </section>
    </aside>

    <main class="workspace">
      <div class="canvas-toolbar">
        <span id="status">Pointer: click a wall or cabinet to select it.</span>
        <span class="units">Units: inches · 1 ft grid</span>
      </div>
      <div class="canvas-stage" id="stage">
        <svg id="plan" xmlns="http://www.w3.org/2000/svg"></svg>
      </div>
    </main>
  </div>
`;

const svg = document.getElementById("plan");
const toolsEl = document.getElementById("tools");
const propsEl = document.getElementById("props");
const statusEl = document.getElementById("status");
const stage = document.getElementById("stage");

const TOOLS = [
    {
        id: "pointer",
        label: "Pointer",
        blurb: "Select walls or cabinets. Drag the dots to move; drag a wall's ends to reshape it.",
    },
    {
        id: "wall",
        label: "Walls",
        blurb: "Click start, then end. Draw at any angle; Shift locks to horizontal/vertical.",
    },
    {
        id: "cabinet",
        label: "Cabinets",
        blurb: "Click to drop. Back snaps flush within 1 ft of a wall. Drag the dot to move.",
    },
];

function nextFreeId(used) {
    const taken = new Set(used);
    let id = 1;
    while (taken.has(id)) id++;
    return id;
}

function nextCabinetId() {
    return nextFreeId(state.cabinets.map((c) => c.id));
}

function nextWallId() {
    return nextFreeId(state.walls.map((w) => w.id));
}

function setTool(id) {
    state.tool = id;
    state.drawing = null;
    state.hover = null;
    state.dragging = null;
    render();
}

function cornerSnapDist() {
    return Math.max(GRID_MINOR * 0.75, 18 / state.view.scale);
}

function snapDrawPoint(raw, start = null, freeAngle = false) {
    return snapWallPoint(raw, state.walls, {
        gridSize: GRID_MINOR,
        cornerDist: cornerSnapDist(),
        start,
        freeAngle,
    });
}

function defaultStatus() {
    if (state.dragging?.kind === "cabinet") {
        const cab = state.cabinets.find((c) => c.id === state.dragging.id);
        if (state.dragging.snappedCabinetId) {
            return `Moving cabinet ${state.dragging.id} (snapped to cabinet ${state.dragging.snappedCabinetId}). Release to drop. Esc cancels.`;
        }
        const where = cab?.wallId ? `snapped to wall ${cab.wallId}` : "freestanding";
        return `Moving cabinet ${state.dragging.id} (${where}). Release to drop. Esc cancels.`;
    }
    if (state.dragging?.kind === "wall-endpoint") {
        const wall = state.walls.find((w) => w.id === state.dragging.id);
        const len = wall ? formatInches(wallLength(wall)) : "";
        return `Moving wall ${state.dragging.id} ${state.dragging.end} end (${len}). Snaps to grid & corners. Shift = ortho lock. Release to drop. Esc cancels.`;
    }
    if (state.dragging?.kind === "wall-move") {
        return `Moving wall ${state.dragging.id}. Attached cabinets follow. Hold Shift to snap to grid. Release to drop. Esc cancels.`;
    }
    if (state.tool === "pointer") {
        return "Pointer: click to select. Drag a dot to move a cabinet or wall; drag a wall's ends to reshape it. Click empty space to clear. Space flips wall side.";
    }
    if (state.tool === "wall") {
        return state.drawing
            ? "Click to finish the wall. Snaps to corners & grid. Space flips side. Esc cancels. Shift = ortho lock."
            : "Click to start a wall. Snaps to corners or 1 ft grid. Space flips side.";
    }
    if (state.tool === "cabinet") {
        return "Click to place a cabinet (snaps within 1 ft of a wall). Drag a cabinet's center dot to move it.";
    }
    return "";
}

function clientToWorld(event) {
    const rect = svg.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    return {
        x: (px - state.view.panX) / state.view.scale,
        y: (py - state.view.panY) / state.view.scale,
    };
}

function hitTest(point) {
    for (let i = state.cabinets.length - 1; i >= 0; i--) {
        const cabinet = state.cabinets[i];
        if (pointInPolygon(point, cabinetPolygon(cabinet, state.walls))) {
            return { type: "cabinet", id: cabinet.id };
        }
    }
    for (let i = state.walls.length - 1; i >= 0; i--) {
        const wall = state.walls[i];
        if (pointInPolygon(point, wallPolygon(wall, state.walls))) {
            return { type: "wall", id: wall.id };
        }
    }
    return null;
}

function cabinetCenter(cabinet) {
    const corners = cabinetCorners(cabinet, state.walls);
    return {
        x: (corners.bl.x + corners.br.x + corners.fr.x + corners.fl.x) / 4,
        y: (corners.bl.y + corners.br.y + corners.fr.y + corners.fl.y) / 4,
    };
}

function dragHandleVisualRadius() {
    return 4 / state.view.scale;
}

function dragHandleHitRadius() {
    return 8 / state.view.scale;
}

function hitDragHandle(point) {
    const hitR = dragHandleHitRadius();
    for (let i = state.cabinets.length - 1; i >= 0; i--) {
        const cabinet = state.cabinets[i];
        const c = cabinetCenter(cabinet);
        if (Math.hypot(point.x - c.x, point.y - c.y) <= hitR) {
            return { type: "cabinet-handle", id: cabinet.id };
        }
    }
    return null;
}

function wallMid(wall) {
    return { x: (wall.x1 + wall.x2) / 2, y: (wall.y1 + wall.y2) / 2 };
}

function hitWallHandle(point) {
    if (state.selected?.type !== "wall") return null;
    const wall = state.walls.find((w) => w.id === state.selected.id);
    if (!wall) return null;
    const hitR = dragHandleHitRadius();
    if (Math.hypot(point.x - wall.x1, point.y - wall.y1) <= hitR) {
        return { type: "wall-endpoint", id: wall.id, end: "start" };
    }
    if (Math.hypot(point.x - wall.x2, point.y - wall.y2) <= hitR) {
        return { type: "wall-endpoint", id: wall.id, end: "end" };
    }
    const mid = wallMid(wall);
    if (Math.hypot(point.x - mid.x, point.y - mid.y) <= hitR) {
        return { type: "wall-move", id: wall.id };
    }
    return null;
}

function clampWallCabinets(wall) {
    const len = wallLength(wall);
    for (const cabinet of state.cabinets) {
        if (cabinet.wallId !== wall.id) continue;
        cabinet.along = clamp(cabinet.along, cabinet.width / 2, Math.max(cabinet.width / 2, len - cabinet.width / 2));
    }
}

function snapshotWallCabinets(wallId) {
    return state.cabinets.filter((c) => c.wallId === wallId).map((c) => ({ id: c.id, along: c.along }));
}

function restoreWallCabinets(snapshot) {
    for (const snap of snapshot) {
        const cabinet = state.cabinets.find((c) => c.id === snap.id);
        if (cabinet) cabinet.along = snap.along;
    }
}

function startWallEndpointDrag(event, wallId, end, raw) {
    const wall = state.walls.find((w) => w.id === wallId);
    if (!wall) return false;
    state.dragging = {
        kind: "wall-endpoint",
        id: wallId,
        end,
        pointerId: event.pointerId,
        orig: { ...wall },
        origCabinets: snapshotWallCabinets(wallId),
        moved: false,
        startX: raw.x,
        startY: raw.y,
    };
    state.selected = { type: "wall", id: wallId };
    state.hover = null;
    try {
        svg.setPointerCapture(event.pointerId);
    } catch {
        // ignore if capture unsupported
    }
    render();
    return true;
}

function startWallMoveDrag(event, wallId, raw) {
    const wall = state.walls.find((w) => w.id === wallId);
    if (!wall) return false;
    state.dragging = {
        kind: "wall-move",
        id: wallId,
        pointerId: event.pointerId,
        orig: { ...wall },
        origCabinets: snapshotWallCabinets(wallId),
        moved: false,
        startX: raw.x,
        startY: raw.y,
    };
    state.selected = { type: "wall", id: wallId };
    state.hover = null;
    try {
        svg.setPointerCapture(event.pointerId);
    } catch {
        // ignore if capture unsupported
    }
    render();
    return true;
}

function selectItem(item) {
    state.selected = item;
    render();
}

function deleteSelected() {
    if (!state.selected) return;
    if (state.selected.type === "wall") {
        const id = state.selected.id;
        state.cabinets = state.cabinets.map((c) => {
            if (c.wallId !== id) return c;
            const corners = cabinetCorners(c, state.walls);
            return { ...c, wallId: null, x: corners.back.x, y: corners.back.y };
        });
        state.walls = state.walls.filter((w) => w.id !== id);
    } else if (state.selected.type === "cabinet") {
        state.cabinets = state.cabinets.filter((c) => c.id !== state.selected.id);
    }
    state.selected = null;
    renumberCabinets();
    render();
}

function renumberCabinets() {
    const oldToNew = renumberCabinetIds(state.cabinets, state.walls);
    if (state.selected?.type === "cabinet") {
        const next = oldToNew.get(state.selected.id);
        if (next != null) state.selected.id = next;
    }
}

function cabinetFromClick(point, id = nextCabinetId()) {
    const near = nearestWall(point, state.walls);
    if (near && near.dist <= SNAP_DISTANCE) {
        const along = clamp(
            near.along,
            DEFAULT_CABINET.width / 2,
            Math.max(DEFAULT_CABINET.width / 2, wallLength(near.wall) - DEFAULT_CABINET.width / 2)
        );
        return {
            id,
            wallId: near.wall.id,
            along,
            side: near.side,
            width: DEFAULT_CABINET.width,
            depth: DEFAULT_CABINET.depth,
            height: DEFAULT_CABINET.height,
            x: null,
            y: null,
            rotation: 0,
        };
    }
    return {
        id,
        wallId: null,
        along: 0,
        side: 1,
        width: DEFAULT_CABINET.width,
        depth: DEFAULT_CABINET.depth,
        height: DEFAULT_CABINET.height,
        x: point.x,
        y: point.y,
        rotation: 0,
    };
}

function previewCabinet(point) {
    const cabinet = cabinetFromClick(point, -1);
    resolveCabinetCollisions(cabinet);
    return cabinet;
}

function syncDetachedCabinets() {
    for (const cabinet of state.cabinets) {
        if (!cabinet.wallId) {
            const corners = cabinetCorners(cabinet, state.walls);
            cabinet.x = corners.back.x;
            cabinet.y = corners.back.y;
        }
    }
}

function cabinetBackCenter(cabinet) {
    return cabinetCorners(cabinet, state.walls).back;
}

function rotationForDetach(cabinet) {
    if (cabinet.wallId) {
        const wall = state.walls.find((w) => w.id === cabinet.wallId);
        if (wall) {
            const angle = Math.atan2(wall.y2 - wall.y1, wall.x2 - wall.x1);
            return cabinet.side === 1 ? angle : angle + Math.PI;
        }
    }
    return cabinet.rotation || 0;
}

function moveCabinetToPoint(cabinet, targetBack) {
    const near = nearestWall(targetBack, state.walls);
    if (near && near.dist <= SNAP_DISTANCE) {
        const maxAlong = Math.max(cabinet.width / 2, wallLength(near.wall) - cabinet.width / 2);
        cabinet.wallId = near.wall.id;
        cabinet.along = clamp(near.along, cabinet.width / 2, maxAlong);
        cabinet.side = near.side;
        cabinet.x = null;
        cabinet.y = null;
    } else {
        if (cabinet.wallId) {
            cabinet.rotation = rotationForDetach(cabinet);
        }
        cabinet.wallId = null;
        cabinet.along = 0;
        cabinet.side = 1;
        cabinet.x = targetBack.x;
        cabinet.y = targetBack.y;
    }
    const snapId = resolveCabinetCollisions(cabinet);
    if (state.dragging?.id === cabinet.id) {
        state.dragging.snappedCabinetId = snapId;
    }
}

function shiftCabinetPose(cabinet, vx, vy) {
    if (cabinet.wallId) {
        const wall = state.walls.find((w) => w.id === cabinet.wallId);
        if (!wall) return 0;
        const len = wallLength(wall) || 1;
        const dx = (wall.x2 - wall.x1) / len;
        const dy = (wall.y2 - wall.y1) / len;
        const maxAlong = Math.max(cabinet.width / 2, len - cabinet.width / 2);
        const before = cabinet.along;
        cabinet.along = clamp(cabinet.along + vx * dx + vy * dy, cabinet.width / 2, maxAlong);
        return Math.abs(cabinet.along - before);
    }
    cabinet.x += vx;
    cabinet.y += vy;
    return Math.hypot(vx, vy);
}

function resolveCabinetCollisions(cabinet) {
    let pushedId = null;
    // Pass 1: push out of shallow overlaps. Deep overlaps are left alone
    // so the user can force an overlap by dragging aggressively.
    for (const other of state.cabinets) {
        if (other.id === cabinet.id) continue;
        const hit = polygonsOverlapSAT(
            cabinetPolygon(cabinet, state.walls),
            cabinetPolygon(other, state.walls)
        );
        if (!hit.overlap) continue;
        if (hit.depth > CABINET_OVERLAP_ALLOW) continue;
        shiftCabinetPose(cabinet, hit.nx * hit.depth, hit.ny * hit.depth);
        pushedId = other.id;
    }
    if (pushedId) return pushedId;
    // Pass 2: edge snap when close but not overlapping.
    let best = null;
    for (const other of state.cabinets) {
        if (other.id === cabinet.id) continue;
        const me = cabinetPolygon(cabinet, state.walls);
        const them = cabinetPolygon(other, state.walls);
        if (polygonsOverlapSAT(me, them).overlap) continue;
        const gap = polygonGapVector(me, them);
        if (gap.dist <= CABINET_SNAP && (!best || gap.dist < best.gap.dist)) {
            best = { id: other.id, gap };
        }
    }
    if (!best) return null;
    const before = { ...cabinet };
    shiftCabinetPose(cabinet, best.gap.vx, best.gap.vy);
    // Don't snap into another cabinet.
    for (const other of state.cabinets) {
        if (other.id === cabinet.id) continue;
        if (polygonsOverlapSAT(cabinetPolygon(cabinet, state.walls), cabinetPolygon(other, state.walls)).overlap) {
            Object.assign(cabinet, before);
            return null;
        }
    }
    return best.id;
}

function updateWall(id, patch) {
    const wall = state.walls.find((w) => w.id === id);
    if (!wall) return;
    Object.assign(wall, patch);
    if (patch.length != null) {
        const len = Math.max(1, Number(patch.length));
        const current = wallLength(wall) || 1;
        const dx = (wall.x2 - wall.x1) / current;
        const dy = (wall.y2 - wall.y1) / current;
        wall.x2 = wall.x1 + dx * len;
        wall.y2 = wall.y1 + dy * len;
        delete wall.length;
    }
    for (const cabinet of state.cabinets) {
        if (cabinet.wallId === wall.id) {
            const maxAlong = Math.max(cabinet.width / 2, wallLength(wall) - cabinet.width / 2);
            cabinet.along = clamp(cabinet.along, cabinet.width / 2, maxAlong);
        }
    }
    render();
}

function updateCabinet(id, patch) {
    const cabinet = state.cabinets.find((c) => c.id === id);
    if (!cabinet) return;
    Object.assign(cabinet, patch);
    if (cabinet.wallId) {
        const wall = state.walls.find((w) => w.id === cabinet.wallId);
        if (wall) {
            const maxAlong = Math.max(cabinet.width / 2, wallLength(wall) - cabinet.width / 2);
            cabinet.along = clamp(cabinet.along, cabinet.width / 2, maxAlong);
        }
    }
    render();
}

function gridPath(width, height) {
    const { panX, panY, scale } = state.view;
    const left = -panX / scale;
    const top = -panY / scale;
    const right = (width - panX) / scale;
    const bottom = (height - panY) / scale;
    const lines = [];
    const startX = Math.floor(left / GRID_MINOR) * GRID_MINOR;
    const startY = Math.floor(top / GRID_MINOR) * GRID_MINOR;
    for (let x = startX; x <= right; x += GRID_MINOR) {
        const major = Math.round(x) % GRID_MAJOR === 0;
        lines.push(
            `<line class="${major ? "grid-major" : "grid-minor"}" x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" />`
        );
    }
    for (let y = startY; y <= bottom; y += GRID_MINOR) {
        const major = Math.round(y) % GRID_MAJOR === 0;
        lines.push(
            `<line class="${major ? "grid-major" : "grid-minor"}" x1="${left}" y1="${y}" x2="${right}" y2="${y}" />`
        );
    }
    return lines.join("");
}

function renderTools() {
    toolsEl.innerHTML = TOOLS.map(
        (tool) => `
      <button type="button" class="tool ${state.tool === tool.id ? "active" : ""}" data-tool="${tool.id}">
        <span class="tool-name">${tool.label}</span>
        <span class="tool-blurb">${tool.blurb}</span>
      </button>
    `
    ).join("");
    toolsEl.querySelectorAll(".tool").forEach((btn) => {
        btn.addEventListener("click", () => setTool(btn.dataset.tool));
    });
}

function numField(label, name, value, opts = {}) {
    return `
    <label class="field">
      <span>${label}</span>
      <span class="field-input">
        <input type="number" name="${name}" value="${value}" min="${opts.min ?? 1}" step="${opts.step ?? 0.125}" />
        <span class="unit">in</span>
      </span>
    </label>
  `;
}

function renderProps() {
    const selected = state.selected;
    if (!selected) {
        propsEl.innerHTML = `<p class="empty">Nothing selected. Click a wall or cabinet on the canvas.</p>`;
        return;
    }
    if (selected.type === "wall") {
        const wall = state.walls.find((w) => w.id === selected.id);
        if (!wall) {
            propsEl.innerHTML = `<p class="empty">Nothing selected.</p>`;
            return;
        }
        propsEl.innerHTML = `
      <div class="props-title">Wall ${wall.id}</div>
      ${numField("Length", "length", roundInput(wallLength(wall)))}
      ${numField("Width", "thickness", roundInput(wall.thickness), { min: 0.5 })}
      ${numField("Height", "height", roundInput(wall.height))}
      <div class="field" style="margin-top: 10px;">
        <span>Side</span>
        <button type="button" class="tool-btn" id="flip-wall-btn">Flip Side</button>
      </div>
      <p class="hint">Length keeps the start point and stretches the other end. Space or Flip Side flips thickness direction.</p>
    `;
        bindPropInputs((name, value) => updateWall(wall.id, { [name]: value }));
        document.getElementById("flip-wall-btn")?.addEventListener("click", () => {
            updateWall(wall.id, { side: -(wall.side || -1) });
        });
        return;
    }
    const cabinet = state.cabinets.find((c) => c.id === selected.id);
    if (!cabinet) {
        propsEl.innerHTML = `<p class="empty">Nothing selected.</p>`;
        return;
    }
    const mount = cabinet.wallId ? `snapped to wall ${cabinet.wallId}` : "freestanding";
    propsEl.innerHTML = `
    <div class="props-title">Cabinet ${cabinet.id}</div>
    <p class="hint">${mount}</p>
    ${numField("Width", "width", roundInput(cabinet.width))}
    ${numField("Depth", "depth", roundInput(cabinet.depth))}
    ${numField("Height", "height", roundInput(cabinet.height))}
  `;
    bindPropInputs((name, value) => updateCabinet(cabinet.id, { [name]: value }));
}

function roundInput(value) {
    return Math.round(value * 1000) / 1000;
}

function bindPropInputs(onChange) {
    propsEl.querySelectorAll("input").forEach((input) => {
        input.addEventListener("change", () => {
            const value = Number(input.value);
            if (!Number.isFinite(value) || value <= 0) return;
            onChange(input.name, value);
        });
    });
}

function renderSvg() {
    const width = stage.clientWidth || 800;
    const height = stage.clientHeight || 600;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));

    const { panX, panY, scale } = state.view;
    const world = `<g transform="translate(${panX} ${panY}) scale(${scale})">`;
    svg.classList.toggle("is-pointer", state.tool === "pointer");
    svg.classList.toggle("is-dragging", state.dragging != null);

    const walls = state.walls
        .map((wall) => {
            const selected = state.selected?.type === "wall" && state.selected.id === wall.id;
            const len = formatInches(wallLength(wall));
            const poly = wallPolygon(wall, state.walls);
            const midX = (poly[0].x + poly[1].x + poly[2].x + poly[3].x) / 4;
            const midY = (poly[0].y + poly[1].y + poly[2].y + poly[3].y) / 4;
            return `
        <g class="item wall ${selected ? "selected" : ""}" data-type="wall" data-id="${wall.id}">
          <path d="${pointsToPath(poly)}" />
          <text class="label" x="${midX}" y="${midY}" text-anchor="middle" dominant-baseline="middle">${len}</text>
        </g>
      `;
        })
        .join("");

    const cabinets = state.cabinets
        .map((cabinet) => cabinetMarkup(cabinet, false))
        .join("");

    const showHandles = state.tool === "pointer" || state.tool === "cabinet";
    const handles = showHandles
        ? state.cabinets
              .map((cabinet) => {
                  const c = cabinetCenter(cabinet);
                  const r = dragHandleVisualRadius();
                  const selected =
                      state.selected?.type === "cabinet" && state.selected.id === cabinet.id;
                  const active = state.dragging?.id === cabinet.id;
                  return `<circle class="drag-handle ${selected ? "selected" : ""} ${active ? "active" : ""}" cx="${c.x}" cy="${c.y}" r="${r}" data-handle="${cabinet.id}" />`;
              })
              .join("")
        : "";

    let wallHandles = "";
    if (state.tool === "pointer" && state.selected?.type === "wall") {
        const wall = state.walls.find((w) => w.id === state.selected.id);
        if (wall) {
            const r = dragHandleVisualRadius();
            const active = state.dragging?.kind?.startsWith("wall-") && state.dragging?.id === wall.id;
            const mid = wallMid(wall);
            wallHandles = `
        <circle class="wall-handle endpoint" cx="${wall.x1}" cy="${wall.y1}" r="${r}" data-wall-end="start" data-wall="${wall.id}" />
        <circle class="wall-handle endpoint" cx="${wall.x2}" cy="${wall.y2}" r="${r}" data-wall-end="end" data-wall="${wall.id}" />
        <circle class="wall-handle move ${active ? "active" : ""}" cx="${mid.x}" cy="${mid.y}" r="${r}" data-wall-move="${wall.id}" />
      `;
        }
    }

    let preview = "";
    if (state.drawing?.kind === "wall") {
        const w = state.drawing.preview;
        if (w) {
            preview += `<path class="preview-wall" d="${pointsToPath(wallPolygon(w, state.walls))}" />`;
        }
        const snap = state.drawing.snap;
        if (snap) {
            const r = 3 / state.view.scale;
            preview += `<circle class="snap-mark ${snap.kind}" cx="${snap.x}" cy="${snap.y}" r="${r}" />`;
        }
    } else if (state.hover?.kind === "wall-snap") {
        const snap = state.hover.snap;
        const r = 3 / state.view.scale;
        preview += `<circle class="snap-mark ${snap.kind}" cx="${snap.x}" cy="${snap.y}" r="${r}" />`;
    }
    if (state.hover?.kind === "cabinet") {
        preview += cabinetMarkup(state.hover.cabinet, true);
    }

    svg.innerHTML = `
    ${world}
      <g class="grid">${gridPath(width, height)}</g>
      ${walls}
      ${cabinets}
      ${handles}
      ${wallHandles}
      ${preview}
    </g>
  `;
}

function cabinetMarkup(cabinet, preview) {
    const corners = cabinetCorners(cabinet, state.walls);
    const selected = !preview && state.selected?.type === "cabinet" && state.selected.id === cabinet.id;
    const poly = pointsToPath([corners.bl, corners.br, corners.fr, corners.fl]);
    const back = `M ${corners.bl.x} ${corners.bl.y} L ${corners.br.x} ${corners.br.y}`;
    const dims = `${roundInput(cabinet.width)} × ${roundInput(cabinet.depth)}`;
    const cx = (corners.bl.x + corners.br.x + corners.fr.x + corners.fl.x) / 4;
    const cy = (corners.bl.y + corners.br.y + corners.fr.y + corners.fl.y) / 4;
    const idLabel = preview ? "" : `<text class="label cabinet-id" x="${cx}" y="${cy - 2.4}" text-anchor="middle" dominant-baseline="middle">#${cabinet.id}</text>`;
    const dimsY = preview ? cy : cy + 2.8;
    return `
    <g class="item cabinet ${selected ? "selected" : ""} ${preview ? "preview" : ""}" data-type="cabinet" data-id="${cabinet.id}">
      <path d="${poly}" />
      <path class="back-edge" d="${back}" />
      ${idLabel}
      <text class="label cabinet-dims" x="${cx}" y="${dimsY}" text-anchor="middle" dominant-baseline="middle">${dims}</text>
    </g>
  `;
}

function render() {
    syncDetachedCabinets();
    renderTools();
    renderProps();
    renderSvg();
    statusEl.textContent = defaultStatus();
}

function startCabinetDrag(event, cabinetId, raw) {
    const cabinet = state.cabinets.find((c) => c.id === cabinetId);
    if (!cabinet) return false;
    const back = cabinetBackCenter(cabinet);
    state.dragging = {
        kind: "cabinet",
        id: cabinetId,
        pointerId: event.pointerId,
        grabDX: raw.x - back.x,
        grabDY: raw.y - back.y,
        orig: { ...cabinet },
        moved: false,
        snappedCabinetId: null,
    };
    state.selected = { type: "cabinet", id: cabinetId };
    state.hover = null;
    try {
        svg.setPointerCapture(event.pointerId);
    } catch {
        // ignore if capture unsupported
    }
    render();
    return true;
}

function onPointerDown(event) {
    if (event.button === 1 || event.button === 2 || (event.button === 0 && event.spaceKey)) {
        return;
    }
    if (event.button !== 0) return;
    const raw = clientToWorld(event);

    if (state.tool === "pointer") {
        const wallHandle = hitWallHandle(raw);
        if (wallHandle) {
            if (wallHandle.type === "wall-move") {
                startWallMoveDrag(event, wallHandle.id, raw);
            } else {
                startWallEndpointDrag(event, wallHandle.id, wallHandle.end, raw);
            }
            return;
        }
        const handle = hitDragHandle(raw);
        if (handle) {
            startCabinetDrag(event, handle.id, raw);
            return;
        }
        const hit = hitTest(raw);
        selectItem(hit);
        return;
    }

    if (state.tool === "wall") {
        if (state.drawing?.kind === "wall") {
            const end = snapDrawPoint(raw, state.drawing.start, !event.shiftKey);
            if (Math.hypot(end.x - state.drawing.start.x, end.y - state.drawing.start.y) < 1) {
                state.drawing = null;
                render();
                return;
            }
            const wall = {
                id: nextWallId(),
                x1: state.drawing.start.x,
                y1: state.drawing.start.y,
                x2: end.x,
                y2: end.y,
                side: state.drawing.side ?? -1,
                thickness: DEFAULT_WALL.thickness,
                height: DEFAULT_WALL.height,
            };
            state.walls.push(wall);
            state.drawing = null;
            selectItem({ type: "wall", id: wall.id });
            return;
        }

        const corner = nearestWallCorner(raw, state.walls, cornerSnapDist());
        const hit = hitTest(raw);
        if (hit?.type === "wall" && !corner) {
            selectItem(hit);
            return;
        }

        const start = snapDrawPoint(raw);
        state.selected = null;
        state.drawing = {
            kind: "wall",
            start,
            preview: null,
            snap: start,
            side: -1,
            userFlippedSide: false,
        };
        render();
        return;
    }

    if (state.tool === "cabinet") {
        const handle = hitDragHandle(raw);
        if (handle) {
            startCabinetDrag(event, handle.id, raw);
            return;
        }
        const hit = hitTest(raw);
        if (hit?.type === "cabinet") {
            selectItem(hit);
            return;
        }
        const cabinet = cabinetFromClick(raw);
        resolveCabinetCollisions(cabinet);
        state.cabinets.push(cabinet);
        renumberCabinets();
        state.hover = null;
        selectItem({ type: "cabinet", id: cabinet.id });
    }
}

function onPointerMove(event) {
    if (state.panning) {
        state.view.panX += event.clientX - state.panning.x;
        state.view.panY += event.clientY - state.panning.y;
        state.panning = { x: event.clientX, y: event.clientY };
        renderSvg();
        return;
    }

    if (state.dragging?.kind === "wall-endpoint") {
        if (state.dragging.pointerId != null && event.pointerId != null && event.pointerId !== state.dragging.pointerId) {
            return;
        }
        const wall = state.walls.find((w) => w.id === state.dragging.id);
        if (!wall) {
            state.dragging = null;
            render();
            return;
        }
        const raw = clientToWorld(event);
        if (!state.dragging.moved && Math.hypot(raw.x - state.dragging.startX, raw.y - state.dragging.startY) < 2 / state.view.scale) {
            return;
        }
        state.dragging.moved = true;
        const fixed =
            state.dragging.end === "start" ? { x: wall.x2, y: wall.y2 } : { x: wall.x1, y: wall.y1 };
        const snapped = snapDrawPoint(raw, fixed, !event.shiftKey);
        if (Math.hypot(snapped.x - fixed.x, snapped.y - fixed.y) >= 1) {
            if (state.dragging.end === "start") {
                wall.x1 = snapped.x;
                wall.y1 = snapped.y;
            } else {
                wall.x2 = snapped.x;
                wall.y2 = snapped.y;
            }
            clampWallCabinets(wall);
        }
        renderSvg();
        statusEl.textContent = defaultStatus();
        return;
    }

    if (state.dragging?.kind === "wall-move") {
        if (state.dragging.pointerId != null && event.pointerId != null && event.pointerId !== state.dragging.pointerId) {
            return;
        }
        const wall = state.walls.find((w) => w.id === state.dragging.id);
        if (!wall) {
            state.dragging = null;
            render();
            return;
        }
        const raw = clientToWorld(event);
        if (!state.dragging.moved && Math.hypot(raw.x - state.dragging.startX, raw.y - state.dragging.startY) < 2 / state.view.scale) {
            return;
        }
        state.dragging.moved = true;
        const dx = raw.x - state.dragging.startX;
        const dy = raw.y - state.dragging.startY;
        let nx1 = state.dragging.orig.x1 + dx;
        let ny1 = state.dragging.orig.y1 + dy;
        if (event.shiftKey) {
            const snapped = snapToGrid({ x: nx1, y: ny1 }, GRID_MINOR);
            nx1 = snapped.x;
            ny1 = snapped.y;
        }
        wall.x1 = nx1;
        wall.y1 = ny1;
        wall.x2 = nx1 + (state.dragging.orig.x2 - state.dragging.orig.x1);
        wall.y2 = ny1 + (state.dragging.orig.y2 - state.dragging.orig.y1);
        renderSvg();
        statusEl.textContent = defaultStatus();
        return;
    }

    if (state.dragging?.kind === "cabinet") {
        if (state.dragging.pointerId != null && event.pointerId != null && event.pointerId !== state.dragging.pointerId) {
            return;
        }
        const raw = clientToWorld(event);
        const cabinet = state.cabinets.find((c) => c.id === state.dragging.id);
        if (!cabinet) {
            state.dragging = null;
            render();
            return;
        }
        const targetBack = { x: raw.x - state.dragging.grabDX, y: raw.y - state.dragging.grabDY };
        const origBack = cabinetCorners(state.dragging.orig, state.walls).back;
        const origTarget = { x: origBack.x + state.dragging.grabDX, y: origBack.y + state.dragging.grabDY };
        const moveDist = Math.hypot(raw.x - origTarget.x, raw.y - origTarget.y);
        const threshold = 2 / state.view.scale;
        if (!state.dragging.moved && moveDist < threshold) {
            return;
        }
        state.dragging.moved = true;
        moveCabinetToPoint(cabinet, targetBack);
        renderSvg();
        statusEl.textContent = defaultStatus();
        return;
    }

    const raw = clientToWorld(event);
    if (state.drawing?.kind === "wall") {
        const end = snapDrawPoint(raw, state.drawing.start, !event.shiftKey);
        state.drawing.snap = end;

        if (!state.drawing.userFlippedSide && state.walls.length > 0) {
            const autoSide = autoWallSide(state.drawing.start, end, DEFAULT_WALL.thickness, state.walls);
            if (autoSide != null) {
                state.drawing.side = autoSide;
            }
        }

        state.drawing.preview = {
            id: -1,
            x1: state.drawing.start.x,
            y1: state.drawing.start.y,
            x2: end.x,
            y2: end.y,
            side: state.drawing.side ?? -1,
            thickness: DEFAULT_WALL.thickness,
            height: DEFAULT_WALL.height,
        };
        renderSvg();
        const snapNote = end.kind === "corner" ? " · corner snap" : " · grid snap";
        statusEl.textContent = `Wall length ${formatInches(wallLength(state.drawing.preview))}${snapNote} · Space to flip side`;
        return;
    }

    if (state.tool === "wall") {
        state.hover = { kind: "wall-snap", snap: snapDrawPoint(raw) };
        renderSvg();
        return;
    }

    if (state.tool === "cabinet") {
        state.hover = { kind: "cabinet", cabinet: previewCabinet(raw) };
        renderSvg();
    }
}

function onPointerUp(event) {
    state.panning = null;
    if (state.dragging) {
        if (event && state.dragging.pointerId != null && event.pointerId != null && event.pointerId !== state.dragging.pointerId) {
            return;
        }
        const wasMoved = state.dragging.moved;
        const kind = state.dragging.kind;
        state.dragging = null;
        state.hover = null;
        if (kind === "cabinet" && wasMoved) renumberCabinets();
        render();
    }
}

function onWheel(event) {
    event.preventDefault();
    const point = clientToWorld(event);
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    const next = clamp(state.view.scale * factor, 1, 16);
    const rect = svg.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    state.view.panX = px - point.x * next;
    state.view.panY = py - point.y * next;
    state.view.scale = next;
    renderSvg();
}

svg.addEventListener("pointerdown", (event) => {
    if (event.button === 1) {
        event.preventDefault();
        state.panning = { x: event.clientX, y: event.clientY };
        svg.setPointerCapture(event.pointerId);
        return;
    }
    onPointerDown(event);
});
svg.addEventListener("pointermove", onPointerMove);
svg.addEventListener("pointerup", onPointerUp);
svg.addEventListener("pointercancel", onPointerUp);
svg.addEventListener("pointerleave", () => {
    if (state.panning || state.dragging) return;
    state.hover = null;
    if (state.tool === "cabinet" || state.tool === "wall") renderSvg();
});
svg.addEventListener("wheel", onWheel, { passive: false });
svg.addEventListener("contextmenu", (event) => event.preventDefault());

window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        if (state.dragging?.kind === "cabinet") {
            const cabinet = state.cabinets.find((c) => c.id === state.dragging.id);
            if (cabinet) Object.assign(cabinet, state.dragging.orig);
            state.dragging = null;
            state.hover = null;
            render();
            return;
        }
        if (state.dragging?.kind === "wall-endpoint" || state.dragging?.kind === "wall-move") {
            const wall = state.walls.find((w) => w.id === state.dragging.id);
            if (wall) Object.assign(wall, state.dragging.orig);
            restoreWallCabinets(state.dragging.origCabinets);
            state.dragging = null;
            state.hover = null;
            render();
            return;
        }
        if (state.drawing) {
            state.drawing = null;
            state.hover = null;
            render();
            return;
        }
        state.hover = null;
        setTool("pointer");
    }
    if (event.key === "Delete" || event.key === "Backspace") {
        const tag = document.activeElement?.tagName;
        if (tag === "INPUT") return;
        deleteSelected();
    }
    if (event.key === "Tab" && !event.shiftKey && state.selected?.type === "cabinet") {
        // Let natural tab order continue once focus is already inside the props panel.
        if (!propsEl.contains(document.activeElement)) {
            const first = propsEl.querySelector(".field input") ?? propsEl.querySelector("input");
            if (first) {
                event.preventDefault();
                first.focus();
                first.select?.();
            }
        }
    }
    if (event.key === " ") {
        event.preventDefault();
        if (state.drawing?.kind === "wall") {
            state.drawing.side = -(state.drawing.side || -1);
            state.drawing.userFlippedSide = true;
            if (state.drawing.preview) {
                state.drawing.preview.side = state.drawing.side;
            }
            renderSvg();
        } else if (state.selected?.type === "wall") {
            const wall = state.walls.find((w) => w.id === state.selected.id);
            if (wall) {
                updateWall(wall.id, { side: -(wall.side || -1) });
            }
        }
    }
});

window.addEventListener("pointerdown", (event) => {
    if (event.button === 1) event.preventDefault();
});

window.addEventListener("pointermove", (event) => {
    if (event.buttons === 4 && !state.panning) {
        state.panning = { x: event.clientX, y: event.clientY };
    }
});

const resize = new ResizeObserver(() => renderSvg());
resize.observe(stage);

render();
