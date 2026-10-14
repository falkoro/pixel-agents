import {
  OFFICE3D_DEPTH_FORESHORTEN,
  OFFICE3D_DESK_PITCH_X,
  OFFICE3D_DESK_PITCH_Z,
  OFFICE3D_DESKS_PER_ROW,
  OFFICE3D_ROOM_GAP,
  OFFICE3D_ROOM_PAD_BACK,
  OFFICE3D_ROOM_PAD_FRONT,
  OFFICE3D_ROOM_PAD_X,
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
 * back-left corner. The column count is the one that lets the whole office fill
 * the most of a viewport with the given width/height `aspect`. Every room gets
 * the size of the fullest one so the grid stays regular.
 */
export function planOffice(rooms: RoomModel[], aspect: number): OfficePlan {
  const maxDesks = Math.max(1, ...rooms.map((r) => r.desks.length));
  const deskCols = Math.min(maxDesks, OFFICE3D_DESKS_PER_ROW);
  const deskRows = Math.ceil(maxDesks / deskCols);
  const roomW = deskCols * OFFICE3D_DESK_PITCH_X + 2 * OFFICE3D_ROOM_PAD_X;
  const roomD = OFFICE3D_ROOM_PAD_BACK + deskRows * OFFICE3D_DESK_PITCH_Z + OFFICE3D_ROOM_PAD_FRONT;
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
      const x = -width / 2 + (i % columns) * (roomW + OFFICE3D_ROOM_GAP) + roomW / 2;
      const z = -depth / 2 + Math.floor(i / columns) * (roomD + OFFICE3D_ROOM_GAP) + roomD / 2;
      return {
        id: room.id,
        x,
        z,
        width: roomW,
        depth: roomD,
        desks: room.desks.map((desk, d) => {
          const row = Math.floor(d / deskCols);
          const inRow = Math.min(deskCols, room.desks.length - row * deskCols);
          return {
            agentId: desk.agentId,
            x: x + ((d % deskCols) - (inRow - 1) / 2) * OFFICE3D_DESK_PITCH_X,
            z: z - roomD / 2 + OFFICE3D_ROOM_PAD_BACK + (row + 0.5) * OFFICE3D_DESK_PITCH_Z,
          };
        }),
      };
    }),
  };
}
