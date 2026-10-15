import type { Texture } from 'three';
import {
  ACESFilmicToneMapping,
  CanvasTexture,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  MOUSE,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Raycaster,
  Scene,
  Spherical,
  Sprite,
  SRGBColorSpace,
  TOUCH,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

import {
  OFFICE3D_ANIMATION_FPS,
  OFFICE3D_CAMERA_FOV,
  OFFICE3D_CAMERA_MAX_POLAR,
  OFFICE3D_CAMERA_MIN_DISTANCE,
  OFFICE3D_CAMERA_POLAR,
  OFFICE3D_CAMERA_POLAR_NARROW,
  OFFICE3D_CLICK_SLOP_PX,
  OFFICE3D_COLORS as C,
  OFFICE3D_DESK_PITCH_X,
  OFFICE3D_FIT_MARGIN,
  OFFICE3D_FOCUS_DURATION_MS,
  OFFICE3D_INSET_BOTTOM_PX,
  OFFICE3D_INSET_SIDE_PX,
  OFFICE3D_INSET_TOP_PX,
  OFFICE3D_MAX_PIXEL_RATIO,
  OFFICE3D_NARROW_ASPECT,
  OFFICE3D_ROOM_GAP,
  OFFICE3D_SCREEN_HEIGHT_PX,
  OFFICE3D_SCREEN_WIDTH_PX,
  OFFICE3D_STATUS_COLORS,
} from '../constants.js';
import type { Figure, Heat, Look, RoomShell } from './assets.js';
import {
  BEAM_H,
  beamGeometry,
  buildChair,
  buildDesk,
  buildFigure,
  buildPlant,
  buildRoomShell,
  CHAIR_Z,
  FLOOR_Y,
  glowGeometry,
  gridTexture,
  Kit,
  mesh,
  ringGeometry,
} from './assets.js';
import type { DeskSpot, OfficePlan, RoomSpot } from './layout.js';
import { planOffice } from './layout.js';
import type { DeskModel, DeskStatus, HelperModel, RoomModel } from './model.js';
import { BACKGROUND_ROOM_ID, roomDesks, roomHeat, STATUS_TEXT } from './model.js';
import { paintScreen } from './screen.js';

export interface OfficeSnapshot {
  rooms: RoomModel[];
  looks: ReadonlyMap<number, Look>;
  selectedId: number | null;
}

export interface SceneCallbacks {
  onPick(agentId: number): void;
  onFocus(roomId: string | null): void;
}

// yaw, torso, head, roll, left shoulder x/z, left elbow, right shoulder x/z, right elbow
type Pose = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

const SEATED: Record<DeskStatus, Pose> = {
  working: [0, -0.1, -0.12, 0, 0.75, -0.14, 1.0, 0.75, 0.14, 1.0],
  'needs-permission': [Math.PI, 0.04, 0.2, 0, 0.35, -0.1, 0.8, 2.9, 0.35, 0.25],
  'waiting-input': [2.2, 0, 0.08, 0.25, 0.35, -0.1, 0.8, 2.55, 0.3, 1.2],
  done: [0.45, 0.22, 0.2, 0, 2.6, -0.5, 2.1, 2.6, 0.5, 2.1],
  idle: [0.18, -0.28, -0.5, 0, 0.45, -0.08, 1.15, 0.45, 0.08, 1.15],
};

const STANDING: Record<DeskStatus, Pose> = {
  working: [0, -0.06, -0.3, 0, 0.8, -0.12, 1.25, 0.8, 0.12, 1.25],
  'needs-permission': [0, 0, 0.2, 0, 0.1, -0.12, 0.1, 2.9, 0.3, 0.3],
  'waiting-input': [0, 0, 0.1, 0.2, 0.1, -0.12, 0.1, 2.55, 0.25, 1.1],
  done: [0, 0.04, 0.1, 0, 0.06, -0.1, 0.1, 0.06, 0.1, 0.1],
  idle: [0, -0.1, -0.35, 0, 0.06, -0.08, 0.1, 0.06, 0.08, 0.1],
};

const MOVING: ReadonlySet<DeskStatus> = new Set(['working', 'needs-permission', 'waiting-input']);

const BADGES: Partial<Record<DeskStatus, 'alert' | 'ask' | 'check'>> = {
  'needs-permission': 'alert',
  'waiting-input': 'ask',
  done: 'check',
};

const HEAT_ORDER: readonly DeskStatus[] = [
  'needs-permission',
  'waiting-input',
  'working',
  'done',
  'idle',
];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  parent?.append(node);
  return node;
}

function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

/** Eases a figure toward its status pose and layers the status's motion on top. */
class Poser {
  private readonly cur: number[];
  private target: Pose;
  private readonly fig: Figure;
  private readonly swivel: Group | null;
  private readonly seed: number;

  constructor(fig: Figure, swivel: Group | null, pose: Pose, seed: number) {
    this.fig = fig;
    this.swivel = swivel;
    this.seed = seed;
    this.cur = [...pose];
    this.target = pose;
  }

  set(pose: Pose): void {
    this.target = pose;
  }

  /** Returns true while the figure still needs frames. */
  step(dt: number, t: number, status: DeskStatus): boolean {
    const k = 1 - Math.exp(-dt * 7);
    let settling = false;
    for (let i = 0; i < this.cur.length; i++) {
      const d = this.target[i] - this.cur[i];
      if (Math.abs(d) > 0.002) settling = true;
      this.cur[i] += d * k;
    }
    const [yaw, torso, head, roll, sx0, sz0, ex0, sx1, sz1, ex1] = this.cur;
    const { fig } = this;
    if (this.swivel) this.swivel.rotation.y = yaw;
    fig.torso.rotation.x = torso;
    fig.head.rotation.set(head, 0, roll);
    fig.shoulders[0].rotation.set(sx0, 0, sz0);
    fig.shoulders[1].rotation.set(sx1, 0, sz1);
    fig.elbows[0].rotation.set(ex0, 0, 0);
    fig.elbows[1].rotation.set(ex1, 0, 0);

    const s = this.seed;
    if (status === 'working') {
      fig.elbows[0].rotation.x += 0.16 * Math.sin(t * 15 + s);
      fig.elbows[1].rotation.x += 0.16 * Math.sin(t * 15 + s + 2.2);
      fig.head.rotation.x += 0.04 * Math.sin(t * 1.9 + s);
    } else if (status === 'needs-permission') {
      fig.elbows[1].rotation.z = 0.65 * Math.sin(t * 9 + s);
      fig.torso.rotation.z = 0.05 * Math.sin(t * 9 + s);
    } else if (status === 'waiting-input') {
      fig.head.rotation.z += 0.1 * Math.sin(t * 1.6 + s);
      fig.shoulders[1].rotation.z += 0.08 * Math.sin(t * 1.6 + s);
    }
    return settling || MOVING.has(status);
  }
}

interface HelperView {
  group: Group;
  fig: Figure;
  poser: Poser;
  badge: Sprite;
  hit: Mesh;
  status: DeskStatus | null;
}

class DeskView {
  readonly group = new Group();
  readonly hits: Mesh[] = [];
  private status: DeskStatus | null = null;
  private readonly chair: Group;
  private figure: Figure;
  private poser: Poser;
  private lookKey: string;
  private readonly canvas = document.createElement('canvas');
  private readonly screenTexture: CanvasTexture;
  private readonly screenMaterial: MeshBasicMaterial;
  private screenKey = '';
  private readonly glow: Mesh;
  private readonly beam: Mesh;
  private readonly ring: Mesh;
  private readonly selection: Mesh;
  private readonly badge: Sprite;
  private readonly label: CSS2DObject;
  private readonly labelEl: HTMLButtonElement;
  private readonly nameEl: HTMLSpanElement;
  private readonly crewEl: HTMLSpanElement;
  private readonly statusEl: HTMLSpanElement;
  private readonly helpers = new Map<number, HelperView>();
  private readonly seed: number;
  private readonly kit: Kit;
  private readonly hitMaterial: MeshBasicMaterial;

  constructor(
    kit: Kit,
    agentId: number,
    look: Look,
    hitMaterial: MeshBasicMaterial,
    onPick: (id: number) => void,
    anisotropy: number,
  ) {
    this.kit = kit;
    this.hitMaterial = hitMaterial;
    this.seed = (agentId * 2.399) % (Math.PI * 2);
    this.canvas.width = OFFICE3D_SCREEN_WIDTH_PX;
    this.canvas.height = OFFICE3D_SCREEN_HEIGHT_PX;
    this.screenTexture = new CanvasTexture(this.canvas);
    this.screenTexture.colorSpace = SRGBColorSpace;
    this.screenTexture.anisotropy = anisotropy;
    this.screenMaterial = new MeshBasicMaterial({ map: this.screenTexture, toneMapped: false });
    this.group.add(buildDesk(kit, this.screenMaterial));

    this.chair = buildChair(kit);
    this.chair.position.z = CHAIR_Z;
    this.group.add(this.chair);
    this.lookKey = `${look.palette}:${look.hueShift}`;
    this.figure = buildFigure(kit, look, true);
    this.figure.root.position.y = 0.5;
    this.chair.add(this.figure.root);
    this.poser = new Poser(this.figure, this.chair, SEATED.idle, this.seed);

    this.glow = mesh(glowGeometry(kit), kit.glow('working'), 0, FLOOR_Y + 0.004, -0.25, false);
    this.glow.renderOrder = 1;
    this.beam = mesh(
      beamGeometry(kit),
      kit.beam('needs-permission'),
      0,
      FLOOR_Y + BEAM_H / 2,
      CHAIR_Z,
      false,
    );
    this.beam.renderOrder = 2;
    this.ring = mesh(
      ringGeometry(kit),
      kit.ring(OFFICE3D_STATUS_COLORS['needs-permission']),
      0,
      FLOOR_Y + 0.008,
      CHAIR_Z,
      false,
    );
    this.ring.renderOrder = 1;
    this.selection = mesh(
      ringGeometry(kit),
      kit.ring(C.selection),
      0,
      FLOOR_Y + 0.01,
      CHAIR_Z,
      false,
    );
    this.selection.scale.setScalar(0.85);
    this.badge = new Sprite(kit.badge('alert', OFFICE3D_STATUS_COLORS['needs-permission']));
    this.badge.position.set(0, FLOOR_Y + 1.85, CHAIR_Z);
    this.badge.renderOrder = 10;
    this.group.add(this.glow, this.beam, this.ring, this.selection, this.badge);

    const hit = new Mesh(kit.box(1.7, 1.7, 2.1), hitMaterial);
    hit.position.set(0, 0.85, -0.25);
    hit.visible = false;
    hit.userData.agentId = agentId;
    this.hits.push(hit);
    this.group.add(hit);

    this.labelEl = el('button', 'o3d-desk');
    this.labelEl.type = 'button';
    const row = el('span', 'o3d-desk-row', this.labelEl);
    el('span', 'o3d-dot', row);
    this.nameEl = el('span', 'o3d-desk-name', row);
    this.crewEl = el('span', 'o3d-desk-crew', row);
    this.statusEl = el('span', 'o3d-desk-status', this.labelEl);
    this.labelEl.addEventListener('click', (e) => {
      e.stopPropagation();
      onPick(agentId);
    });
    this.label = new CSS2DObject(this.labelEl);
    this.label.position.set(0, FLOOR_Y, 1.05);
    this.group.add(this.label);
  }

  place(spot: DeskSpot): void {
    // Scaling about the group origin would sink the desk below the floor slab.
    this.group.position.set(spot.x, FLOOR_Y * (1 - spot.scale), spot.z);
    this.group.scale.setScalar(spot.scale);
    this.labelEl.dataset.background = String(spot.scale < 1);
  }

  apply(model: DeskModel, look: Look, selected: boolean): void {
    const lookKey = `${look.palette}:${look.hueShift}`;
    if (lookKey !== this.lookKey) {
      this.lookKey = lookKey;
      this.chair.remove(this.figure.root);
      this.figure = buildFigure(this.kit, look, true);
      this.figure.root.position.y = 0.5;
      this.chair.add(this.figure.root);
      this.poser = new Poser(this.figure, this.chair, SEATED[model.status], this.seed);
    }

    const { status } = model;
    if (status !== this.status) {
      this.status = status;
      this.poser.set(SEATED[status]);
      this.glow.visible = status !== 'idle';
      this.glow.material = this.kit.glow(status);
      this.beam.visible = status === 'needs-permission';
      this.ring.visible = status === 'needs-permission' || status === 'waiting-input';
      this.ring.material = this.kit.ring(OFFICE3D_STATUS_COLORS[status]);
      this.ring.scale.setScalar(1);
      const glyph = BADGES[status];
      this.badge.visible = glyph !== undefined;
      if (glyph) this.badge.material = this.kit.badge(glyph, OFFICE3D_STATUS_COLORS[status]);
      this.badge.scale.setScalar(status === 'done' ? 0.36 : 0.5);
    }
    this.selection.visible = selected;

    const activity = model.tool ?? STATUS_TEXT[status];
    const screenLines = [STATUS_TEXT[status], model.tool ?? model.name];
    const screenKey = `${status}|${screenLines.join('|')}`;
    if (screenKey !== this.screenKey) {
      this.screenKey = screenKey;
      paintScreen(this.canvas, screenLines, OFFICE3D_STATUS_COLORS[status], status !== 'idle');
      this.screenTexture.needsUpdate = true;
    }

    this.labelEl.dataset.status = status;
    this.labelEl.dataset.selected = String(selected);
    this.labelEl.title = `${model.name}: ${activity}`;
    setText(this.nameEl, model.name);
    setText(this.crewEl, model.helpers.length > 0 ? `+${model.helpers.length}` : '');
    setText(this.statusEl, status === 'working' ? activity : STATUS_TEXT[status]);

    this.syncHelpers(model.helpers, look);
  }

  private syncHelpers(models: HelperModel[], look: Look): void {
    const live = new Set(models.map((h) => h.agentId));
    for (const [id, helper] of this.helpers) {
      if (live.has(id)) continue;
      this.group.remove(helper.group);
      this.hits.splice(this.hits.indexOf(helper.hit), 1);
      this.helpers.delete(id);
    }
    models.forEach((model, i) => {
      let helper = this.helpers.get(model.agentId);
      if (!helper) {
        const group = new Group();
        const fig = buildFigure(this.kit, look, false);
        fig.root.position.y = 0.88;
        group.add(fig.root);
        group.scale.setScalar(0.62);
        group.rotation.y = 2.3;
        const badge = new Sprite(
          this.kit.badge('alert', OFFICE3D_STATUS_COLORS['needs-permission']),
        );
        badge.position.y = 2.15;
        badge.scale.setScalar(0.55);
        badge.renderOrder = 10;
        group.add(badge);
        const hit = new Mesh(this.kit.box(0.7, 1.8, 0.7), this.hitMaterial);
        hit.position.y = 0.9;
        hit.visible = false;
        hit.userData.agentId = model.agentId;
        group.add(hit);
        this.hits.push(hit);
        const seed = this.seed + model.agentId;
        helper = {
          group,
          fig,
          badge,
          hit,
          status: null,
          poser: new Poser(fig, null, STANDING.idle, seed),
        };
        this.helpers.set(model.agentId, helper);
        this.group.add(group);
      }
      helper.group.position.set(1.02 + Math.floor(i / 4) * 0.42, FLOOR_Y, -0.95 + (i % 4) * 0.45);
      if (helper.status !== model.status) {
        helper.status = model.status;
        helper.poser.set(STANDING[model.status]);
        const glyph = BADGES[model.status];
        helper.badge.visible = glyph !== undefined && model.status !== 'done';
        if (glyph)
          helper.badge.material = this.kit.badge(glyph, OFFICE3D_STATUS_COLORS[model.status]);
      }
    });
  }

  animate(t: number, dt: number): boolean {
    let busy = this.poser.step(dt, t, this.status ?? 'idle');
    if (this.status === 'needs-permission') {
      const phase = (t * 0.9 + this.seed) % 1;
      this.ring.scale.setScalar(1 + phase * 1.1);
      this.badge.scale.setScalar(0.5 * (1 + 0.14 * Math.sin(t * 6)));
    } else if (this.status === 'waiting-input') {
      this.badge.position.y = FLOOR_Y + 1.85 + 0.07 * Math.sin(t * 2 + this.seed);
    }
    for (const helper of this.helpers.values()) {
      busy = helper.poser.step(dt, t, helper.status ?? 'idle') || busy;
      helper.fig.root.position.y =
        0.88 + (helper.status === 'working' ? 0.025 * Math.abs(Math.sin(t * 5 + this.seed)) : 0);
    }
    return busy;
  }

  dispose(): void {
    this.labelEl.remove();
    this.screenTexture.dispose();
    this.screenMaterial.dispose();
  }
}

class RoomView {
  readonly group = new Group();
  private shell: RoomShell | null = null;
  private sizeKey = '';
  private heat: Heat = 'calm';
  private readonly plant: Group;
  private readonly label: CSS2DObject;
  private readonly labelEl: HTMLButtonElement;
  private readonly titleEl: HTMLSpanElement;
  private readonly chipsEl: HTMLSpanElement;
  private chipsKey = '';
  private readonly roster: CSS2DObject;
  private readonly rosterEl: HTMLDivElement;
  private rosterKey = '';
  private readonly kit: Kit;
  private readonly onPick: (id: number) => void;

  constructor(
    kit: Kit,
    id: string,
    onFocus: (id: string) => void,
    onPick: (agentId: number) => void,
  ) {
    this.kit = kit;
    this.onPick = onPick;
    this.plant = buildPlant(kit);
    this.group.add(this.plant);
    this.labelEl = el('button', 'o3d-room');
    this.labelEl.type = 'button';
    this.titleEl = el('span', 'o3d-room-title', this.labelEl);
    this.chipsEl = el('span', 'o3d-room-chips', this.labelEl);
    this.labelEl.addEventListener('click', (e) => {
      e.stopPropagation();
      onFocus(id);
    });
    this.label = new CSS2DObject(this.labelEl);
    // When desks are too small on screen for their own labels, the room lists
    // its agents instead: one readable line each, still clickable.
    this.rosterEl = el('div', 'o3d-roster');
    if (id === BACKGROUND_ROOM_ID) this.rosterEl.dataset.background = 'true';
    this.roster = new CSS2DObject(this.rosterEl);
    this.roster.center.set(0.5, 1);
    this.group.add(this.label, this.roster);
  }

  place(spot: RoomSpot): void {
    this.group.position.set(spot.x, 0, spot.z);
    const sizeKey = `${spot.width}:${spot.depth}`;
    if (sizeKey === this.sizeKey) return;
    this.sizeKey = sizeKey;
    if (this.shell) this.group.remove(this.shell.group);
    this.shell = buildRoomShell(this.kit, spot.width, spot.depth);
    this.group.add(this.shell.group);
    this.paintHeat();
    this.plant.position.set(spot.width / 2 - 0.42, FLOOR_Y, -spot.depth / 2 + 0.45);
    this.label.position.set(0, FLOOR_Y + 0.6, -spot.depth / 2 + 0.14);
    this.roster.position.set(0, FLOOR_Y, spot.depth / 2 - 0.15);
    // The list may spill into the gap between rooms, never past half of it.
    this.rosterEl.style.setProperty(
      '--o3d-room-w',
      (spot.width + OFFICE3D_ROOM_GAP * 0.9).toFixed(2),
    );
  }

  apply(room: RoomModel): void {
    setText(this.titleEl, room.title);
    this.labelEl.title = `Focus ${room.title}`;
    const heat = roomHeat(room);
    const next: Heat = heat === 'needs-permission' || heat === 'waiting-input' ? heat : 'calm';
    if (next !== this.heat) {
      this.heat = next;
      this.paintHeat();
    }
    this.labelEl.dataset.heat = this.heat;
    this.labelEl.dataset.pinned = String(room.pods.some((pod) => pod.pinned));

    this.syncRoster(room);
    const counts = new Map<DeskStatus, number>();
    for (const desk of roomDesks(room)) counts.set(desk.status, (counts.get(desk.status) ?? 0) + 1);
    const chips = HEAT_ORDER.filter((s) => counts.has(s));
    const chipsKey = chips.map((s) => `${s}:${counts.get(s)}`).join(',');
    if (chipsKey === this.chipsKey) return;
    this.chipsKey = chipsKey;
    this.chipsEl.replaceChildren(
      ...chips.map((s) => {
        const chip = el('span', 'o3d-chip');
        chip.dataset.status = s;
        chip.title = `${counts.get(s)} ${STATUS_TEXT[s].toLowerCase()}`;
        chip.textContent = String(counts.get(s));
        return chip;
      }),
    );
  }

  private syncRoster(room: RoomModel): void {
    const desks = roomDesks(room);
    const key = JSON.stringify(desks.map((d) => [d.agentId, d.name, d.status]));
    if (key === this.rosterKey) return;
    this.rosterKey = key;
    this.rosterEl.replaceChildren(
      ...desks.map((desk) => {
        const item = el('button', 'o3d-roster-item');
        item.type = 'button';
        item.dataset.status = desk.status;
        item.title = `${desk.name}: ${STATUS_TEXT[desk.status]}`;
        el('span', 'o3d-dot', item);
        el('span', 'o3d-roster-name', item).textContent = desk.name;
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          this.onPick(desk.agentId);
        });
        return item;
      }),
    );
  }

  private paintHeat(): void {
    if (!this.shell) return;
    this.shell.slab.material = this.kit.floor(this.heat);
    for (const edge of this.shell.edges) edge.material = this.kit.edge(this.heat);
  }

  dispose(): void {
    this.labelEl.remove();
    this.rosterEl.remove();
  }
}

interface View {
  target: Vector3;
  orbit: Spherical;
}

interface Tween {
  start: number;
  from: View;
  to: View;
}

interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * The 3D office: owns the renderer, camera, controls, labels and every mesh.
 * It renders on demand, keeps a 30 fps loop only while something moves, and
 * stops entirely while the tab is hidden.
 */
export class OfficeScene {
  private readonly renderer: WebGLRenderer;
  private readonly labels = new CSS2DRenderer();
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(OFFICE3D_CAMERA_FOV, 1, 0.1, 600);
  private readonly fitCamera = new PerspectiveCamera(OFFICE3D_CAMERA_FOV, 1, 0.1, 600);
  private readonly controls: OrbitControls;
  private readonly kit = new Kit();
  private readonly key = new DirectionalLight(C.keyLight, 2.6);
  private readonly fog = new Fog(C.background, 60, 200);
  private readonly environment: Texture;
  private readonly hitMaterial = new MeshBasicMaterial();
  private readonly rooms = new Map<string, RoomView>();
  private readonly desks = new Map<number, DeskView>();
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly cleanup: Array<() => void> = [];
  private snapshot: OfficeSnapshot = { rooms: [], looks: new Map(), selectedId: null };
  private plan: OfficePlan = planOffice([], 1);
  private planKey = '';
  private focusId: string | null = null;
  private pendingHash: string | null;
  private userMoved = false;
  private tween: Tween | null = null;
  private raf = 0;
  private timer = 0;
  private lastFrame = 0;
  private labelKey = '';
  private width = 0;
  private height = 0;
  private down: { x: number; y: number; button: number; dragged: boolean } | null = null;
  private disposed = false;
  private readonly host: HTMLElement;
  private readonly callbacks: SceneCallbacks;

  constructor(host: HTMLElement, callbacks: SceneCallbacks) {
    this.host = host;
    this.callbacks = callbacks;
    const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer = renderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, OFFICE3D_MAX_PIXEL_RATIO));
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    renderer.domElement.className = 'o3d-canvas';
    this.labels.domElement.className = 'o3d-labels';
    host.append(renderer.domElement, this.labels.domElement);

    const pmrem = new PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    this.environment = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
    this.scene.environment = this.environment;
    this.scene.environmentIntensity = 0.5;
    this.scene.background = new Color(C.background);
    this.scene.fog = this.fog;

    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.radius = 5;
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.025;
    this.scene.add(this.key, this.key.target, new HemisphereLight(C.sky, C.groundBounce, 0.75));

    const grid = gridTexture();
    grid.repeat.set(200, 200);
    grid.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const ground = mesh(
      this.kit.geo('ground', () => new PlaneGeometry(400, 400).rotateX(-Math.PI / 2)),
      this.kit.material(
        'ground',
        () => new MeshStandardMaterial({ color: C.ground, roughness: 0.95, map: grid }),
      ),
    );
    ground.castShadow = false;
    this.kit.texture('grid', () => grid);
    this.scene.add(ground);

    const controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls = controls;
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.screenSpacePanning = false;
    controls.zoomToCursor = true;
    controls.minDistance = OFFICE3D_CAMERA_MIN_DISTANCE;
    controls.minPolarAngle = 0.05;
    controls.maxPolarAngle = OFFICE3D_CAMERA_MAX_POLAR;
    controls.mouseButtons = { LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE };
    controls.touches = { ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_ROTATE };
    controls.addEventListener('change', this.requestRender);

    this.pendingHash = readHash();
    this.listen(renderer.domElement, 'pointerdown', this.onPointerDown);
    this.listen(renderer.domElement, 'pointerup', this.onPointerUp);
    this.listen(renderer.domElement, 'pointermove', this.onPointerMove);
    this.listen(renderer.domElement, 'wheel', this.takeOver);
    this.listen(renderer.domElement, 'pointercancel', () => (this.down = null));
    this.listen(document, 'visibilitychange', this.onVisibility);
    this.listen(window, 'hashchange', this.onHashChange);
    this.listen(this.labels.domElement, 'wheel', this.forwardWheel, { passive: false });
    const observer = new ResizeObserver(() => this.resize());
    observer.observe(host);
    this.cleanup.push(() => observer.disconnect());
    this.resize();
  }

  update(snapshot: OfficeSnapshot): void {
    if (this.disposed) return;
    this.snapshot = snapshot;
    const deskIds = new Set(snapshot.rooms.flatMap((r) => roomDesks(r).map((d) => d.agentId)));
    for (const [id, desk] of this.desks) {
      if (deskIds.has(id)) continue;
      desk.dispose();
      this.scene.remove(desk.group);
      this.desks.delete(id);
    }
    const roomIds = new Set(snapshot.rooms.map((r) => r.id));
    for (const [id, room] of this.rooms) {
      if (roomIds.has(id)) continue;
      room.dispose();
      this.scene.remove(room.group);
      this.rooms.delete(id);
    }

    const anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    for (const model of snapshot.rooms) {
      let room = this.rooms.get(model.id);
      if (!room) {
        room = new RoomView(this.kit, model.id, (id) => this.focusRoom(id), this.callbacks.onPick);
        this.rooms.set(model.id, room);
        this.scene.add(room.group);
      }
      room.apply(model);
      for (const deskModel of roomDesks(model)) {
        const look = snapshot.looks.get(deskModel.agentId) ?? { palette: 0, hueShift: 0 };
        let desk = this.desks.get(deskModel.agentId);
        if (!desk) {
          desk = new DeskView(
            this.kit,
            deskModel.agentId,
            look,
            this.hitMaterial,
            this.callbacks.onPick,
            anisotropy,
          );
          this.desks.set(deskModel.agentId, desk);
          this.scene.add(desk.group);
        }
        const sel = snapshot.selectedId;
        desk.apply(
          deskModel,
          look,
          sel !== null &&
            (sel === deskModel.agentId || deskModel.helpers.some((h) => h.agentId === sel)),
        );
      }
    }

    if (this.focusId !== null && !this.rooms.has(this.focusId)) this.focusId = null;
    this.layout();
    if (this.pendingHash !== null && this.rooms.has(this.pendingHash)) {
      const id = this.pendingHash;
      this.pendingHash = null;
      this.focusRoom(id);
    }
    this.requestRender();
  }

  /** Glide to one room, or to the whole office with `null`. Mirrors the choice in the URL hash. */
  focusRoom(id: string | null): void {
    if (this.disposed) return;
    this.focusId = id !== null && this.rooms.has(id) ? id : null;
    this.pendingHash = null;
    this.userMoved = false;
    const url = new URL(window.location.href);
    url.hash = this.focusId === null ? '' : encodeURIComponent(this.focusId);
    if (url.href !== window.location.href) window.history.replaceState(null, '', url);
    this.callbacks.onFocus(this.focusId);
    this.applyFocus(true);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.timer);
    for (const off of this.cleanup) off();
    this.controls.dispose();
    for (const desk of this.desks.values()) desk.dispose();
    for (const room of this.rooms.values()) room.dispose();
    this.kit.dispose();
    this.hitMaterial.dispose();
    this.environment.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }

  readonly requestRender = (): void => {
    if (this.disposed || document.hidden || this.raf) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = 0;
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  private readonly frame = (now: number): void => {
    this.raf = 0;
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    const t = now / 1000;

    const tweening = this.stepTween(now);
    const moved = this.controls.update();
    let animating = false;
    for (const desk of this.desks.values()) animating = desk.animate(t, dt) || animating;
    this.pulseShared(t);
    this.syncCameraDependents();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);

    if (tweening || moved) {
      this.raf = requestAnimationFrame(this.frame);
    } else if (animating) {
      this.timer = window.setTimeout(() => {
        this.timer = 0;
        if (!this.raf && !this.disposed && !document.hidden) {
          this.raf = requestAnimationFrame(this.frame);
        }
      }, 1000 / OFFICE3D_ANIMATION_FPS);
    } else {
      this.lastFrame = 0;
    }
  };

  private pulseShared(t: number): void {
    const pulse = 0.5 + 0.5 * Math.sin(t * 5);
    this.kit.beam('needs-permission').opacity = 0.45 + 0.4 * pulse;
    this.kit.glow('needs-permission').opacity = 0.65 + 0.35 * pulse;
    this.kit.floor('needs-permission').emissiveIntensity = 0.06 + 0.12 * pulse;
    this.kit.ring(OFFICE3D_STATUS_COLORS['needs-permission']).opacity = 1 - ((t * 0.9) % 1);
  }

  /** Label size, density and fog follow the zoom. */
  private syncCameraDependents(): void {
    const dist = this.camera.position.distanceTo(this.controls.target);
    const ppm = this.height / (2 * dist * Math.tan(MathUtils.degToRad(this.camera.fov / 2)));
    const pitch = ppm * OFFICE3D_DESK_PITCH_X;
    const density = pitch >= 150 ? 'full' : pitch >= 110 ? 'compact' : 'roster';
    const key = `${ppm.toFixed(1)}|${density}`;
    if (key === this.labelKey) return;
    this.labelKey = key;
    const style = this.labels.domElement.style;
    style.setProperty('--o3d-ppm', ppm.toFixed(1));
    this.labels.domElement.dataset.density = density;
    this.fog.near = dist * 1.6;
    this.fog.far = dist * 4;
  }

  private layout(): void {
    const animate = this.planKey !== '';
    this.plan = planOffice(this.snapshot.rooms, this.camera.aspect);
    for (const spot of this.plan.rooms) {
      this.rooms.get(spot.id)?.place(spot);
      for (const d of spot.desks) this.desks.get(d.agentId)?.place(d);
    }
    const planKey = JSON.stringify([
      this.plan.columns,
      this.plan.width,
      this.plan.depth,
      this.plan.rooms.map((r) => r.id),
    ]);
    if (planKey === this.planKey) return;
    this.planKey = planKey;

    const reach = Math.hypot(this.plan.width, this.plan.depth) / 2 + 2;
    this.key.position.set(-0.55 * reach, 1.3 * reach, 0.85 * reach);
    const cam = this.key.shadow.camera;
    cam.left = -reach;
    cam.right = reach;
    cam.top = reach;
    cam.bottom = -reach;
    cam.near = 0.5;
    cam.far = reach * 4;
    cam.updateProjectionMatrix();
    this.controls.maxTargetRadius = reach;
    this.controls.maxDistance = Math.max(
      30,
      this.fitView(this.overviewBounds()).orbit.radius * 2.2,
    );

    if (!this.userMoved) this.applyFocus(animate);
  }

  private overviewBounds(): Bounds {
    const { width, depth } = this.plan;
    return { minX: -width / 2, maxX: width / 2, minZ: -depth / 2, maxZ: depth / 2 };
  }

  private focusBounds(): Bounds {
    const spot = this.plan.rooms.find((r) => r.id === this.focusId);
    if (!spot) return this.overviewBounds();
    return {
      minX: spot.x - spot.width / 2,
      maxX: spot.x + spot.width / 2,
      minZ: spot.z - spot.depth / 2,
      maxZ: spot.z + spot.depth / 2,
    };
  }

  private applyFocus(animate: boolean): void {
    const to = this.fitView(this.focusBounds());
    if (!animate) {
      this.tween = null;
      this.setView(to);
    } else {
      const orbit = new Spherical().setFromVector3(
        this.camera.position.clone().sub(this.controls.target),
      );
      this.tween = {
        start: performance.now(),
        from: { target: this.controls.target.clone(), orbit },
        to,
      };
    }
    this.requestRender();
  }

  private setView(view: View): void {
    this.controls.target.copy(view.target);
    this.camera.position.setFromSpherical(view.orbit).add(view.target);
    this.camera.lookAt(view.target);
  }

  private stepTween(now: number): boolean {
    const tween = this.tween;
    if (!tween) return false;
    const k = Math.min(1, (now - tween.start) / OFFICE3D_FOCUS_DURATION_MS);
    const e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
    const { from, to } = tween;
    let dTheta = to.orbit.theta - from.orbit.theta;
    dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
    this.setView({
      target: from.target.clone().lerp(to.target, e),
      orbit: new Spherical(
        MathUtils.lerp(from.orbit.radius, to.orbit.radius, e),
        MathUtils.lerp(from.orbit.phi, to.orbit.phi, e),
        from.orbit.theta + dTheta * e,
      ),
    });
    if (k >= 1) this.tween = null;
    return true;
  }

  /**
   * Camera that frames `b` (plus the height of desks and labels) inside the
   * viewport minus the room bar and toolbar, looking straight down -z.
   */
  private fitView(b: Bounds): View {
    const aspect = this.camera.aspect;
    const polar =
      aspect < OFFICE3D_NARROW_ASPECT ? OFFICE3D_CAMERA_POLAR_NARROW : OFFICE3D_CAMERA_POLAR;
    const cam = this.fitCamera;
    cam.aspect = aspect;
    cam.updateProjectionMatrix();
    const h = Math.max(1, this.height);
    const w = Math.max(1, this.width);
    const xMax = Math.min(OFFICE3D_FIT_MARGIN, 1 - (2 * OFFICE3D_INSET_SIDE_PX) / w);
    const yMax = Math.min(OFFICE3D_FIT_MARGIN, 1 - (2 * OFFICE3D_INSET_TOP_PX) / h);
    const yMin = Math.max(-OFFICE3D_FIT_MARGIN, -1 + (2 * OFFICE3D_INSET_BOTTOM_PX) / h);
    const corners: Vector3[] = [];
    for (const x of [b.minX, b.maxX]) {
      for (const z of [b.minZ, b.maxZ]) {
        for (const y of [0, 1.6]) corners.push(new Vector3(x, y, z));
      }
    }
    const target = new Vector3((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
    const p = new Vector3();
    const project = (radius: number) => {
      cam.position.set(0, Math.cos(polar), Math.sin(polar)).multiplyScalar(radius).add(target);
      cam.lookAt(target);
      cam.updateMatrixWorld();
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      for (const c of corners) {
        p.copy(c).project(cam);
        x0 = Math.min(x0, p.x);
        x1 = Math.max(x1, p.x);
        y0 = Math.min(y0, p.y);
        y1 = Math.max(y1, p.y);
      }
      return { x0, x1, y0, y1 };
    };
    const tanHalf = Math.tan(MathUtils.degToRad(cam.fov / 2));
    let radius = 20;
    for (let pass = 0; pass < 4; pass++) {
      let lo = 0.5;
      let hi = 800;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        const r = project(mid);
        if (r.x0 >= -xMax && r.x1 <= xMax && r.y0 >= yMin && r.y1 <= yMax) hi = mid;
        else lo = mid;
      }
      radius = hi;
      const r = project(radius);
      target.x += ((r.x0 + r.x1) / 2) * radius * tanHalf * aspect;
      target.z -= (((r.y0 + r.y1) / 2 - (yMin + yMax) / 2) * radius * tanHalf) / Math.cos(polar);
    }
    return { target, orbit: new Spherical(radius, polar, 0) };
  }

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.labelKey = '';
    this.planKey = '';
    this.layout();
    this.requestRender();
  }

  private pick(e: PointerEvent): number | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const targets = [...this.desks.values()].flatMap((d) => d.hits);
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    return hit ? (hit.object.userData.agentId as number) : null;
  }

  private listen<T extends EventTarget>(
    target: T,
    type: string,
    handler: (e: never) => void,
    options?: AddEventListenerOptions,
  ): void {
    const fn = handler as EventListener;
    target.addEventListener(type, fn, options);
    this.cleanup.push(() => target.removeEventListener(type, fn, options));
  }

  /** The user steered the camera: stop gliding and stop refitting on layout changes. */
  private readonly takeOver = (): void => {
    this.tween = null;
    this.userMoved = true;
  };

  // A click must not count as steering, or the first pick would freeze the fit.
  private readonly onPointerDown = (e: PointerEvent): void => {
    this.down = { x: e.clientX, y: e.clientY, button: e.button, dragged: false };
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const down = this.down;
    this.down = null;
    if (!down || down.dragged || down.button !== 0) return;
    const id = this.pick(e);
    if (id !== null) this.callbacks.onPick(id);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const down = this.down;
    if (down) {
      if (
        !down.dragged &&
        Math.hypot(e.clientX - down.x, e.clientY - down.y) > OFFICE3D_CLICK_SLOP_PX
      ) {
        down.dragged = true;
        this.takeOver();
      }
      return;
    }
    if (e.buttons !== 0 || e.pointerType !== 'mouse') return;
    this.renderer.domElement.style.cursor = this.pick(e) === null ? '' : 'pointer';
  };

  private readonly onVisibility = (): void => {
    if (document.hidden) {
      cancelAnimationFrame(this.raf);
      clearTimeout(this.timer);
      this.raf = 0;
      this.timer = 0;
      this.lastFrame = 0;
    } else {
      this.requestRender();
    }
  };

  private readonly onHashChange = (): void => {
    const id = readHash();
    if (id === null || this.rooms.has(id)) this.focusRoom(id);
    else this.pendingHash = id;
  };

  private readonly forwardWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.renderer.domElement.dispatchEvent(new WheelEvent('wheel', e));
  };
}

function readHash(): string | null {
  const raw = window.location.hash.slice(1);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
