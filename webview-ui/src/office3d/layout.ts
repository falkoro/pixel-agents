import {
  OFFICE3D_BACKGROUND_SCALE,
  OFFICE3D_DEPTH_FORESHORTEN,
  OFFICE3D_DESK_PITCH_X,
  OFFICE3D_DESK_PITCH_Z,
  OFFICE3D_DESKS_PER_ROW,
  OFFICE3D_NARROW_ASPECT,
  OFFICE3D_ROOM_GAP,
  OFFICE3D_ROOM_PAD_BACK,
  OFFICE3D_ROOM_PAD_FRONT,
  OFFICE3D_ROOM_PAD_X,
  OFFICE3D_ROSTER_LINE_DEPTH,
} from '../constants.js';
import type { RoomModel } from './model.js';
import { BACKGROUND_ROOM_ID } from './model.js';

/** Centre of one desk slot on the floor plane (x right, z toward the viewer). */
export interface DeskSpot {
  agentId: number;
  x: number;
  z: number;
  /** 1 in a room, OFFICE3D_BACKGROUND_SCALE in the background strip. Spacing across stays the same so labels fit. */
  scale: number;
}

export interface RoomSpot {
  id: string;
  x: number;
  z: number;
  width: number;
  depth: number;
  desks: DeskSpot[];
}

export interface OfficePlan {
  rooms: RoomSpot[];
  columns: number;
  width: number;
  depth: number;
}

function placeDesks(
  room: RoomModel,
  x: number,
  top: number,
  perRow: number,
  scale: number,
): DeskSpot[] {
  const pitchZ = OFFICE3D_DESK_PITCH_Z * scale;
  return room.desks.map((desk, d) => {
    const row = Math.floor(d / perRow);
    const inRow = Math.min(perRow, room.desks.length - row * perRow);
    return {
      agentId: desk.agentId,
      x: x + ((d % perRow) - (inRow - 1) / 2) * OFFICE3D_DESK_PITCH_X,
      z: top + OFFICE3D_ROOM_PAD_BACK + (row + 0.5) * pitchZ,
      scale,
    };
  });
}

/**
 * Lay rooms out as a uniform grid centred on the origin, reading order from the
 * back-left corner, with a short last row centred under the others. The column
 * count is the one that lets the whole office fill the most of a viewport with
 * the given width/height `aspect`. Every room gets the size of the fullest one
 * so the grid stays regular. On a narrow viewport rooms are too small on screen
 * for per-desk labels, so each room gets extra floor at the front for a list of
 * its agents. The background room is not part of the grid: it is a strip of
 * smaller desks behind it, as wide as the grid.
 */
export function planOffice(rooms: RoomModel[], aspect: number): OfficePlan {
  const grid = rooms.filter((r) => r.id !== BACKGROUND_ROOM_ID);
  const background = rooms.find((r) => r.id === BACKGROUND_ROOM_ID);

  const maxDesks = Math.max(1, ...grid.map((r) => r.desks.length));
  const deskCols = Math.min(maxDesks, OFFICE3D_DESKS_PER_ROW);
  const deskRows = Math.ceil(maxDesks / deskCols);
  const roomW = deskCols * OFFICE3D_DESK_PITCH_X + 2 * OFFICE3D_ROOM_PAD_X;
  const narrow = aspect < OFFICE3D_NARROW_ASPECT;
  const roster = narrow ? maxDesks * OFFICE3D_ROSTER_LINE_DEPTH : 0;
  const roomD =
    OFFICE3D_ROOM_PAD_BACK + deskRows * OFFICE3D_DESK_PITCH_Z + OFFICE3D_ROOM_PAD_FRONT + roster;
  const span = (count: number, size: number): number =>
    count * size + Math.max(0, count - 1) * OFFICE3D_ROOM_GAP;

  const bgCount = background?.desks.length ?? 0;
  const strip = (gridWidth: number) => {
    const minWidth =
      Math.min(bgCount, OFFICE3D_DESKS_PER_ROW) * OFFICE3D_DESK_PITCH_X + 2 * OFFICE3D_ROOM_PAD_X;
    const width = Math.max(gridWidth, minWidth);
    const perRow = Math.max(
      1,
      Math.floor((width - 2 * OFFICE3D_ROOM_PAD_X) / OFFICE3D_DESK_PITCH_X),
    );
    const depth =
      OFFICE3D_ROOM_PAD_BACK +
      Math.ceil(bgCount / perRow) * OFFICE3D_DESK_PITCH_Z * OFFICE3D_BACKGROUND_SCALE +
      OFFICE3D_ROOM_PAD_FRONT +
      (narrow ? bgCount * OFFICE3D_ROSTER_LINE_DEPTH : 0);
    return { width, depth, perRow, extra: depth + (grid.length > 0 ? OFFICE3D_ROOM_GAP : 0) };
  };

  const n = grid.length;
  let columns = 1;
  let bestScale = 0;
  for (let c = 1; c <= n; c++) {
    const rows = Math.ceil(n / c);
    const bg = background ? strip(span(c, roomW)) : null;
    const scale = Math.min(
      aspect / Math.max(span(c, roomW), bg?.width ?? 0),
      1 / ((span(rows, roomD) + (bg?.extra ?? 0)) * OFFICE3D_DEPTH_FORESHORTEN),
    );
    if (scale > bestScale + 1e-9) {
      bestScale = scale;
      columns = c;
    }
  }

  const gridW = span(columns, roomW);
  const gridD = span(Math.ceil(n / columns), roomD);
  const bg = background ? strip(gridW) : null;
  const width = Math.max(gridW, bg?.width ?? 0);
  const depth = gridD + (bg?.extra ?? 0);
  const gridTop = -depth / 2 + (bg?.extra ?? 0);

  return {
    columns,
    width,
    depth,
    rooms: rooms.map((room) => {
      if (room === background && bg) {
        const top = -depth / 2;
        return {
          id: room.id,
          x: 0,
          z: top + bg.depth / 2,
          width: bg.width,
          depth: bg.depth,
          desks: placeDesks(room, 0, top, bg.perRow, OFFICE3D_BACKGROUND_SCALE),
        };
      }
      const i = grid.indexOf(room);
      const row = Math.floor(i / columns);
      const inRow = Math.min(columns, n - row * columns);
      const x = ((i % columns) - (inRow - 1) / 2) * (roomW + OFFICE3D_ROOM_GAP);
      const top = gridTop + row * (roomD + OFFICE3D_ROOM_GAP);
      return {
        id: room.id,
        x,
        z: top + roomD / 2,
        width: roomW,
        depth: roomD,
        desks: placeDesks(room, x, top, deskCols, 1),
      };
    }),
  };
}
