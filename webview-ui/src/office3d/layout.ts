import {
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

/** Centre of one desk slot on the floor plane (x right, z toward the viewer). */
export interface DeskSpot {
  agentId: number;
  x: number;
  z: number;
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

/**
 * Lay rooms out as a uniform grid centred on the origin, reading order from the
 * back-left corner, with a short last row centred under the others. The column count is the one that lets the whole office fill
 * the most of a viewport with the given width/height `aspect`. Every room gets
 * the size of the fullest one so the grid stays regular. On a narrow viewport
 * rooms are too small on screen for per-desk labels, so each room gets extra
 * floor at the front for a list of its agents.
 */
export function planOffice(rooms: RoomModel[], aspect: number): OfficePlan {
  const maxDesks = Math.max(1, ...rooms.map((r) => r.desks.length));
  const deskCols = Math.min(maxDesks, OFFICE3D_DESKS_PER_ROW);
  const deskRows = Math.ceil(maxDesks / deskCols);
  const roomW = deskCols * OFFICE3D_DESK_PITCH_X + 2 * OFFICE3D_ROOM_PAD_X;
  const roster = aspect < OFFICE3D_NARROW_ASPECT ? maxDesks * OFFICE3D_ROSTER_LINE_DEPTH : 0;
  const roomD =
    OFFICE3D_ROOM_PAD_BACK + deskRows * OFFICE3D_DESK_PITCH_Z + OFFICE3D_ROOM_PAD_FRONT + roster;
  const span = (count: number, size: number): number =>
    count * size + Math.max(0, count - 1) * OFFICE3D_ROOM_GAP;

  const n = Math.max(1, rooms.length);
  let columns = 1;
  let bestScale = 0;
  for (let c = 1; c <= n; c++) {
    const rows = Math.ceil(n / c);
    const scale = Math.min(
      aspect / span(c, roomW),
      1 / (span(rows, roomD) * OFFICE3D_DEPTH_FORESHORTEN),
    );
    if (scale > bestScale + 1e-9) {
      bestScale = scale;
      columns = c;
    }
  }

  const width = span(columns, roomW);
  const depth = span(Math.ceil(n / columns), roomD);

  return {
    columns,
    width,
    depth,
    rooms: rooms.map((room, i) => {
      const row = Math.floor(i / columns);
      const inRow = Math.min(columns, rooms.length - row * columns);
      const x = ((i % columns) - (inRow - 1) / 2) * (roomW + OFFICE3D_ROOM_GAP);
      const z = -depth / 2 + row * (roomD + OFFICE3D_ROOM_GAP) + roomD / 2;
      return {
        id: room.id,
        x,
        z,
        width: roomW,
        depth: roomD,
        desks: room.desks.map((desk, d) => {
          const deskRow = Math.floor(d / deskCols);
          const inDeskRow = Math.min(deskCols, room.desks.length - deskRow * deskCols);
          return {
            agentId: desk.agentId,
            x: x + ((d % deskCols) - (inDeskRow - 1) / 2) * OFFICE3D_DESK_PITCH_X,
            z: z - roomD / 2 + OFFICE3D_ROOM_PAD_BACK + (deskRow + 0.5) * OFFICE3D_DESK_PITCH_Z,
          };
        }),
      };
    }),
  };
}
