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
    snapWallPoint,
    wallCorners,
    wallLength,
    wallPolygon,
} from "./geometry.js";

const PX_PER_INCH = 4;
const SNAP_DISTANCE = 36;
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
    nextId: 1,
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
    // {
    //     id: "pointer",
    //     label: "Pointer",
    //     blurb: "Select walls or cabinets. Does not place anything.",
    // },
    {
        id: "wall",
        label: "Walls",
        blurb: "Click start, then end. Snaps to the grid and wall corners.",
    },
    {
        id: "cabinet",
        label: "Cabinets",
        blurb: "Click to drop. Back snaps flush to the nearest wall.",
    },
];

function uid() {
    return state.nextId++;
}

function setTool(id) {
    state.tool = id;
    state.drawing = null;
    state.hover = null;
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
    if (state.tool === "pointer") {
        return "Pointer: click a wall or cabinet to select it. Click empty space to clear. Space flips wall side.";
    }
    if (state.tool === "wall") {
        return state.drawing
            ? "Click to finish the wall. Snaps to corners & grid. Space flips side. Esc cancels. Shift = free angle."
            : "Click to start a wall. Snaps to corners or 1 ft grid. Space flips side.";
    }
    if (state.tool === "cabinet") {
        return "Click to place a cabinet. Click an existing cabinet to edit it.";
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
    render();
}

function cabinetFromClick(point, id = uid()) {
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
    return cabinetFromClick(point, -1);
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
      ${preview}
    </g>
  `;
}

function cabinetMarkup(cabinet, preview) {
    const corners = cabinetCorners(cabinet, state.walls);
    const selected = !preview && state.selected?.type === "cabinet" && state.selected.id === cabinet.id;
    const poly = pointsToPath([corners.bl, corners.br, corners.fr, corners.fl]);
    const back = `M ${corners.bl.x} ${corners.bl.y} L ${corners.br.x} ${corners.br.y}`;
    const label = `${roundInput(cabinet.width)} × ${roundInput(cabinet.depth)}`;
    const cx = (corners.bl.x + corners.br.x + corners.fr.x + corners.fl.x) / 4;
    const cy = (corners.bl.y + corners.br.y + corners.fr.y + corners.fl.y) / 4;
    return `
    <g class="item cabinet ${selected ? "selected" : ""} ${preview ? "preview" : ""}" data-type="cabinet" data-id="${cabinet.id}">
      <path d="${poly}" />
      <path class="back-edge" d="${back}" />
      <text class="label" x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle">${label}</text>
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

function onPointerDown(event) {
    if (event.button === 1 || event.button === 2 || (event.button === 0 && event.spaceKey)) {
        return;
    }
    if (event.button !== 0) return;
    const raw = clientToWorld(event);

    if (state.tool === "pointer") {
        const hit = hitTest(raw);
        selectItem(hit);
        return;
    }

    if (state.tool === "wall") {
        if (state.drawing?.kind === "wall") {
            const end = snapDrawPoint(raw, state.drawing.start, event.shiftKey);
            if (Math.hypot(end.x - state.drawing.start.x, end.y - state.drawing.start.y) < 1) {
                state.drawing = null;
                render();
                return;
            }
            const wall = {
                id: uid(),
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
        const hit = hitTest(raw);
        if (hit?.type === "cabinet") {
            selectItem(hit);
            return;
        }
        const cabinet = cabinetFromClick(raw);
        state.cabinets.push(cabinet);
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

    const raw = clientToWorld(event);
    if (state.drawing?.kind === "wall") {
        const end = snapDrawPoint(raw, state.drawing.start, event.shiftKey);
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

function onPointerUp() {
    state.panning = null;
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
svg.addEventListener("pointerleave", () => {
    if (!state.panning) {
        state.hover = null;
        if (state.tool === "cabinet" || state.tool === "wall") renderSvg();
    }
});
svg.addEventListener("wheel", onWheel, { passive: false });
svg.addEventListener("contextmenu", (event) => event.preventDefault());

window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
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
