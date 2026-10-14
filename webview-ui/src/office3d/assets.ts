import type { BufferGeometry, Material, Texture } from 'three';
import {
  AdditiveBlending,
  BoxGeometry,
  CanvasTexture,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RepeatWrapping,
  RingGeometry,
  SphereGeometry,
  SpriteMaterial,
  SRGBColorSpace,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

import {
  OFFICE3D_COLORS as C,
  OFFICE3D_HAIR,
  OFFICE3D_SHIRTS,
  OFFICE3D_SKINS,
  OFFICE3D_STATUS_COLORS,
} from '../constants.js';
import type { DeskStatus } from './model.js';
import { cssColor } from './screen.js';

/** Top of a room's floor slab; everything in a room stands on it. */
export const FLOOR_Y = 0.06;
/** Desk-slot local offsets: the desk sits behind the chair, the camera looks from +z. */
export const DESK_Z = -0.55;
export const CHAIR_Z = 0.05;
export const BEAM_H = 5;
export const WALL_H = 1.05;

type Disposable = { dispose(): void };

const GLOW_OPACITY: Record<DeskStatus, number> = {
  working: 0.3,
  'needs-permission': 0.85,
  'waiting-input': 0.75,
  done: 0.28,
  idle: 0,
};
export type Heat = 'calm' | 'needs-permission' | 'waiting-input';

export interface Look {
  palette: number;
  hueShift: number;
}

/**
 * Shared geometries, materials and textures, created on first use and disposed
 * together. Every desk and room is built from the same few dozen resources, so
 * an office of a hundred agents costs about as much GPU memory as one.
 */
export class Kit {
  private readonly cache = new Map<string, Disposable>();

  private get<T extends Disposable>(key: string, make: () => T): T {
    let value = this.cache.get(key) as T | undefined;
    if (!value) {
      value = make();
      this.cache.set(key, value);
    }
    return value;
  }

  geo(key: string, make: () => BufferGeometry): BufferGeometry {
    return this.get(`g:${key}`, make);
  }

  box(w: number, h: number, d: number, radius = 0): BufferGeometry {
    return this.geo(`box:${w}:${h}:${d}:${radius}`, () =>
      radius > 0 ? new RoundedBoxGeometry(w, h, d, 3, radius) : new BoxGeometry(w, h, d),
    );
  }

  capsule(radius: number, length: number): BufferGeometry {
    return this.geo(`cap:${radius}:${length}`, () => new CapsuleGeometry(radius, length, 6, 14));
  }

  sphere(radius: number): BufferGeometry {
    return this.geo(`sph:${radius}`, () => new SphereGeometry(radius, 24, 16));
  }

  std(key: string, color: number, roughness: number, metalness = 0): MeshStandardMaterial {
    return this.get(`m:${key}`, () => new MeshStandardMaterial({ color, roughness, metalness }));
  }

  material(key: string, make: () => Material): Material {
    return this.get(`b:${key}`, make);
  }

  texture(key: string, make: () => Texture): Texture {
    return this.get(`t:${key}`, make);
  }

  shirt(palette: number, hueShift: number): MeshStandardMaterial {
    return this.get(`shirt:${palette}:${hueShift}`, () => {
      const color = new Color(OFFICE3D_SHIRTS[palette]);
      if (hueShift) color.offsetHSL(hueShift / 360, 0, 0);
      return new MeshStandardMaterial({ color, roughness: 0.78 });
    });
  }

  floor(heat: Heat): MeshStandardMaterial {
    return this.get(`floor:${heat}`, () => {
      const m = new MeshStandardMaterial({ color: C.roomFloor, roughness: 0.82 });
      if (heat !== 'calm') {
        m.emissive.setHex(OFFICE3D_STATUS_COLORS[heat]);
        m.emissiveIntensity = 0.1;
      }
      return m;
    });
  }

  edge(heat: Heat): MeshBasicMaterial {
    return this.get(
      `edge:${heat}`,
      () =>
        new MeshBasicMaterial({
          color: heat === 'calm' ? C.wallTrim : OFFICE3D_STATUS_COLORS[heat],
          toneMapped: false,
        }),
    );
  }

  /** Additive floor halo in a status colour. */
  glow(status: DeskStatus): MeshBasicMaterial {
    return this.get(
      `glow:${status}`,
      () =>
        new MeshBasicMaterial({
          map: this.texture('radial', radialTexture),
          color: OFFICE3D_STATUS_COLORS[status],
          transparent: true,
          blending: AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
          opacity: GLOW_OPACITY[status],
        }),
    );
  }

  beam(status: DeskStatus): MeshBasicMaterial {
    return this.get(
      `beam:${status}`,
      () =>
        new MeshBasicMaterial({
          map: this.texture('beam', beamTexture),
          color: OFFICE3D_STATUS_COLORS[status],
          transparent: true,
          blending: AdditiveBlending,
          depthWrite: false,
          side: DoubleSide,
          toneMapped: false,
        }),
    );
  }

  ring(color: number): MeshBasicMaterial {
    return this.get(
      `ring:${color}`,
      () =>
        new MeshBasicMaterial({
          color,
          transparent: true,
          blending: AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
        }),
    );
  }

  /** Floating status badge; drawn over everything so it can never hide behind a monitor. */
  badge(glyph: 'alert' | 'ask' | 'check', color: number): SpriteMaterial {
    return this.get(
      `badge:${glyph}:${color}`,
      () =>
        new SpriteMaterial({
          map: badgeTexture(glyph, color),
          depthTest: false,
          depthWrite: false,
          toneMapped: false,
        }),
    );
  }

  dispose(): void {
    for (const value of this.cache.values()) value.dispose();
    this.cache.clear();
  }
}

export function mesh(
  geometry: BufferGeometry,
  material: Material,
  x = 0,
  y = 0,
  z = 0,
  shadows = true,
): Mesh {
  const m = new Mesh(geometry, material);
  m.position.set(x, y, z);
  m.castShadow = shadows;
  m.receiveShadow = shadows;
  return m;
}

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D) => void): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) draw(ctx);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function radialTexture(): Texture {
  return canvasTexture(128, (ctx) => {
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, cssColor(C.white, 1));
    g.addColorStop(0.35, cssColor(C.white, 0.45));
    g.addColorStop(1, cssColor(C.white, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  });
}

function beamTexture(): Texture {
  return canvasTexture(64, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, 64);
    // Brightest just above head height and faint below it, so the beacon
    // never hides the agent it marks.
    g.addColorStop(0, cssColor(C.white, 0));
    g.addColorStop(0.35, cssColor(C.white, 0.6));
    g.addColorStop(0.62, cssColor(C.white, 0.95));
    g.addColorStop(0.7, cssColor(C.white, 0.18));
    g.addColorStop(1, cssColor(C.white, 0.24));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  });
}

export function gridTexture(): Texture {
  const t = canvasTexture(128, (ctx) => {
    ctx.fillStyle = cssColor(C.gridFill);
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = cssColor(C.gridLine);
    ctx.fillRect(0, 0, 128, 2);
    ctx.fillRect(0, 0, 2, 128);
  });
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  return t;
}

function badgeTexture(glyph: 'alert' | 'ask' | 'check', color: number): Texture {
  return canvasTexture(128, (ctx) => {
    ctx.fillStyle = cssColor(color);
    ctx.beginPath();
    ctx.arc(64, 64, 58, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = cssColor(C.white, 0.85);
    ctx.stroke();
    ctx.fillStyle = cssColor(C.badgeGlyph);
    ctx.strokeStyle = cssColor(C.badgeGlyph);
    if (glyph === 'check') {
      ctx.lineWidth = 14;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(38, 66);
      ctx.lineTo(56, 84);
      ctx.lineTo(90, 46);
      ctx.stroke();
      return;
    }
    ctx.font = '900 84px "Adwaita Sans", "Liberation Sans", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(glyph === 'alert' ? '!' : '?', 64, 69);
  });
}

/** A posable figure. Index 0 is the figure's left (-x when facing -z). */
export interface Figure {
  root: Group;
  torso: Group;
  head: Group;
  shoulders: [Group, Group];
  elbows: [Group, Group];
}

export function buildFigure(kit: Kit, look: Look, seated: boolean): Figure {
  const p = ((Math.round(look.palette) % 6) + 6) % 6;
  const shirt = kit.shirt(p, look.hueShift);
  const skin = kit.std(`skin${p}`, OFFICE3D_SKINS[p], 0.62);
  const hair = kit.std(`hair${p}`, OFFICE3D_HAIR[p], 0.9);
  const pants = kit.std('pants', C.pants, 0.85);
  const shoes = kit.std('shoes', C.shoes, 0.5);

  const root = new Group();
  root.add(mesh(kit.box(0.32, 0.14, 0.24, 0.06), pants, 0, 0.06, 0));
  for (const side of [-1, 1]) {
    const x = side * 0.09;
    if (seated) {
      const thigh = mesh(kit.capsule(0.07, 0.28), pants, x, 0.07, -0.17);
      thigh.rotation.x = Math.PI / 2;
      root.add(thigh, mesh(kit.capsule(0.06, 0.32), pants, x, -0.19, -0.35));
      root.add(mesh(kit.box(0.1, 0.07, 0.2, 0.03), shoes, x, -0.43, -0.39));
    } else {
      root.add(mesh(kit.capsule(0.068, 0.6), pants, x, -0.38, 0));
      root.add(mesh(kit.box(0.1, 0.07, 0.2, 0.03), shoes, x, -0.79, -0.04));
    }
  }

  const torso = new Group();
  torso.position.y = 0.08;
  const chest = mesh(kit.capsule(0.15, 0.24), shirt, 0, 0.27, 0);
  chest.scale.set(1.15, 1, 0.8);
  torso.add(
    chest,
    mesh(
      kit.geo('neck', () => new CylinderGeometry(0.05, 0.056, 0.1, 14)),
      skin,
      0,
      0.5,
      0,
    ),
  );

  const head = new Group();
  head.position.y = 0.53;
  const cap = mesh(
    kit.geo('hair', () => new SphereGeometry(0.127, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.6)),
    hair,
    0,
    0.13,
    0,
  );
  cap.rotation.x = 0.45;
  const eye = kit.material('eye', () => new MeshBasicMaterial({ color: C.eye }));
  head.add(mesh(kit.sphere(0.118), skin, 0, 0.13, 0), cap);
  for (const side of [-1, 1]) {
    head.add(mesh(kit.sphere(0.017), eye, side * 0.043, 0.135, -0.108, false));
  }
  torso.add(head);

  const shoulders: Group[] = [];
  const elbows: Group[] = [];
  for (const side of [-1, 1]) {
    const shoulder = new Group();
    shoulder.position.set(side * 0.205, 0.43, 0);
    shoulder.add(mesh(kit.capsule(0.05, 0.18), shirt, 0, -0.12, 0));
    const elbow = new Group();
    elbow.position.y = -0.25;
    elbow.add(mesh(kit.capsule(0.043, 0.16), skin, 0, -0.1, 0));
    elbow.add(mesh(kit.sphere(0.047), skin, 0, -0.21, 0));
    shoulder.add(elbow);
    torso.add(shoulder);
    shoulders.push(shoulder);
    elbows.push(elbow);
  }
  root.add(torso);
  return {
    root,
    torso,
    head,
    shoulders: [shoulders[0], shoulders[1]],
    elbows: [elbows[0], elbows[1]],
  };
}

/** Swivel chair, seat facing -z. Its origin is the swivel axis on the floor. */
export function buildChair(kit: Kit): Group {
  const chair = new Group();
  const fabric = kit.std('fabric', C.chairFabric, 0.92);
  const frame = kit.std('chairFrame', C.chairFrame, 0.4, 0.65);
  const spoke = kit.geo('spoke', () => new BoxGeometry(0.3, 0.03, 0.045).translate(0.15, 0, 0));
  for (let i = 0; i < 5; i++) {
    const s = mesh(spoke, frame, 0, 0.07, 0);
    s.rotation.y = (i / 5) * Math.PI * 2;
    chair.add(s);
    const a = (i / 5) * Math.PI * 2;
    chair.add(mesh(kit.sphere(0.032), frame, Math.cos(a) * 0.29, 0.032, -Math.sin(a) * 0.29));
  }
  chair.add(
    mesh(
      kit.geo('post', () => new CylinderGeometry(0.028, 0.028, 0.34, 12)),
      frame,
      0,
      0.25,
      0,
    ),
  );
  chair.add(mesh(kit.box(0.5, 0.08, 0.48, 0.035), fabric, 0, 0.46, 0));
  chair.add(mesh(kit.box(0.05, 0.3, 0.03), frame, 0, 0.56, 0.25));
  const back = mesh(kit.box(0.48, 0.5, 0.07, 0.03), fabric, 0, 0.82, 0.25);
  back.rotation.x = 0.1;
  chair.add(back);
  return chair;
}

/** Desk with monitor, keyboard and mug. `screen` is the per-desk monitor face. */
export function buildDesk(kit: Kit, screen: Material): Group {
  const desk = new Group();
  const wood = kit.std('wood', C.deskTop, 0.5);
  const frame = kit.std('frame', C.deskFrame, 0.38, 0.7);
  desk.add(mesh(kit.box(1.5, 0.05, 0.75, 0.018), wood, 0, 0.715, DESK_Z));
  for (const side of [-1, 1]) {
    desk.add(mesh(kit.box(0.05, 0.69, 0.68), frame, side * 0.7, 0.345, DESK_Z));
  }
  desk.add(mesh(kit.box(1.35, 0.32, 0.025), frame, 0, 0.5, DESK_Z - 0.32));

  const monitor = new Group();
  monitor.position.set(0, 0.74, DESK_Z - 0.17);
  const bezel = kit.std('bezel', C.monitorBezel, 0.32, 0.45);
  monitor.add(mesh(kit.box(0.26, 0.016, 0.17, 0.006), bezel, 0, 0.008, 0));
  monitor.add(mesh(kit.box(0.045, 0.25, 0.03), bezel, 0, 0.13, -0.03));
  const panel = new Group();
  panel.position.y = 0.43;
  panel.rotation.x = -0.16;
  panel.add(mesh(kit.box(0.72, 0.43, 0.035, 0.012), bezel));
  panel.add(
    mesh(
      kit.geo('screen', () => new PlaneGeometry(0.68, 0.398)),
      screen,
      0,
      0,
      0.0185,
      false,
    ),
  );
  monitor.add(panel);
  desk.add(monitor);

  const keys = kit.std('keyboard', C.keyboard, 0.55);
  desk.add(mesh(kit.box(0.46, 0.022, 0.15, 0.008), keys, 0, 0.751, DESK_Z + 0.17));
  desk.add(mesh(kit.box(0.06, 0.022, 0.1, 0.01), keys, 0.37, 0.751, DESK_Z + 0.17));
  const mug = kit.std('mug', C.mug, 0.3);
  desk.add(
    mesh(
      kit.geo('mug', () => new CylinderGeometry(0.04, 0.035, 0.1, 18)),
      mug,
      -0.56,
      0.79,
      DESK_Z + 0.05,
    ),
  );
  return desk;
}

export function buildPlant(kit: Kit): Group {
  const plant = new Group();
  const pot = kit.std('pot', C.plantPot, 0.6);
  const leaf = kit.std('leaf', C.plantLeaf, 0.7);
  plant.add(
    mesh(
      kit.geo('pot', () => new CylinderGeometry(0.17, 0.13, 0.34, 22)),
      pot,
      0,
      0.17,
      0,
    ),
  );
  const leafGeo = kit.sphere(0.1);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const l = mesh(leafGeo, leaf, Math.cos(a) * 0.09, 0.52 + (i % 2) * 0.1, Math.sin(a) * 0.09);
    l.scale.set(0.55, 2.1, 0.32);
    l.rotation.set(Math.sin(a) * 0.5, -a, -Math.cos(a) * 0.5);
    plant.add(l);
  }
  return plant;
}

export interface RoomShell {
  group: Group;
  slab: Mesh;
  edges: Mesh[];
}

/** A room pod: floor slab, carpet, glowing edge, back wall and glass sides. */
export function buildRoomShell(kit: Kit, w: number, d: number): RoomShell {
  const group = new Group();
  const slab = mesh(kit.box(w, 0.12, d, 0.04), kit.floor('calm'), 0, FLOOR_Y - 0.06, 0);
  slab.castShadow = false;
  const carpet = mesh(
    kit.geo(`carpet:${w}:${d}`, () => new PlaneGeometry(w - 0.6, d - 0.9)),
    kit.std('carpet', C.roomCarpet, 1),
    0,
    FLOOR_Y + 0.002,
    0.15,
  );
  carpet.rotation.x = -Math.PI / 2;
  carpet.castShadow = false;
  group.add(slab, carpet);

  const edge = kit.edge('calm');
  const edges = [
    mesh(kit.box(w, 0.025, 0.035), edge, 0, FLOOR_Y + 0.0125, d / 2 - 0.0175, false),
    mesh(kit.box(w, 0.035, 0.12), edge, 0, FLOOR_Y + WALL_H + 0.0175, -d / 2 + 0.06, false),
  ];
  for (const side of [-1, 1]) {
    edges.push(
      mesh(kit.box(0.035, 0.025, d), edge, side * (w / 2 - 0.0175), FLOOR_Y + 0.0125, 0, false),
    );
  }
  group.add(...edges);

  group.add(
    mesh(
      kit.box(w, WALL_H, 0.1),
      kit.std('wall', C.wall, 0.85),
      0,
      FLOOR_Y + WALL_H / 2,
      -d / 2 + 0.06,
    ),
  );
  const glass = kit.material(
    'glass',
    () =>
      new MeshStandardMaterial({
        color: C.glass,
        roughness: 0.08,
        metalness: 0,
        transparent: true,
        opacity: 0.1,
        depthWrite: false,
      }),
  );
  const rail = kit.std('frame', C.deskFrame, 0.38, 0.7);
  for (const side of [-1, 1]) {
    const x = side * (w / 2 - 0.03);
    const pane = mesh(kit.box(0.025, 0.82, d - 0.16), glass, x, FLOOR_Y + 0.41, 0.04, false);
    group.add(pane, mesh(kit.box(0.05, 0.03, d - 0.14), rail, x, FLOOR_Y + 0.83, 0.04));
  }
  return { group, slab, edges };
}

/** Flat ring on the floor, for pulses and the selection marker. */
export function ringGeometry(kit: Kit): BufferGeometry {
  return kit.geo('ring', () => new RingGeometry(0.6, 0.7, 56).rotateX(-Math.PI / 2));
}

export function glowGeometry(kit: Kit): BufferGeometry {
  return kit.geo('glow', () => new PlaneGeometry(2.6, 2.6).rotateX(-Math.PI / 2));
}

export function beamGeometry(kit: Kit): BufferGeometry {
  return kit.geo('beam', () => new CylinderGeometry(0.34, 0.5, BEAM_H, 40, 1, true));
}
