import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import type { OfficePlan } from '../src/office3d/layout.js';
import { planOffice } from '../src/office3d/layout.js';
import type { DeskModel, RoomModel } from '../src/office3d/model.js';

let nextId = 1;
function room(id: string, desks: number): RoomModel {
  return {
    id,
    title: id,
    desks: Array.from({ length: desks }, (): DeskModel => ({
      agentId: nextId++,
      name: 'a',
      pane: null,
      status: 'idle',
      tool: null,
      contextRatio: 0,
      helpers: [],
    })),
  };
}

function rooms(count: number, desks = 2): RoomModel[] {
  return Array.from({ length: count }, (_, i) => room(`r${i}`, desks));
}

function overlaps(plan: OfficePlan): boolean {
  return plan.rooms.some((a, i) =>
    plan.rooms.some(
      (b, j) =>
        i < j &&
        Math.abs(a.x - b.x) < (a.width + b.width) / 2 &&
        Math.abs(a.z - b.z) < (a.depth + b.depth) / 2,
    ),
  );
}

describe('planOffice', () => {
  test('one room sits at the origin', () => {
    const plan = planOffice(rooms(1), 16 / 9);
    assert.equal(plan.columns, 1);
    assert.equal(plan.rooms[0].x, 0);
    assert.equal(plan.rooms[0].z, 0);
  });

  test('keeps room order and reads left to right, back to front', () => {
    const plan = planOffice(rooms(4), 16 / 9);
    assert.deepEqual(
      plan.rooms.map((r) => r.id),
      ['r0', 'r1', 'r2', 'r3'],
    );
    const [a, b] = plan.rooms;
    assert.ok(b.x > a.x || b.z > a.z);
    const last = plan.rooms[plan.rooms.length - 1];
    assert.ok(last.z >= a.z);
  });

  test('a wide viewport gets more columns than a phone', () => {
    const wide = planOffice(rooms(8), 1600 / 900);
    const phone = planOffice(rooms(8), 390 / 844);
    assert.ok(wide.columns > phone.columns, `${wide.columns} vs ${phone.columns}`);
    assert.ok(wide.width / wide.depth > phone.width / phone.depth);
  });

  test('every count from 1 to 12 fits without overlap and centred', () => {
    for (let n = 1; n <= 12; n++) {
      for (const aspect of [390 / 844, 1, 1600 / 900]) {
        const plan = planOffice(rooms(n), aspect);
        assert.equal(plan.rooms.length, n);
        assert.ok(!overlaps(plan), `overlap at n=${n} aspect=${aspect}`);
        const minX = Math.min(...plan.rooms.map((r) => r.x - r.width / 2));
        const maxX = Math.max(...plan.rooms.map((r) => r.x + r.width / 2));
        const minZ = Math.min(...plan.rooms.map((r) => r.z - r.depth / 2));
        assert.ok(Math.abs(minX + plan.width / 2) < 1e-9);
        assert.ok(maxX <= plan.width / 2 + 1e-9);
        assert.ok(Math.abs(minZ + plan.depth / 2) < 1e-9);
      }
    }
  });

  test('a short last row is centred under the full rows', () => {
    const plan = planOffice(rooms(8), 1600 / 900);
    assert.equal(plan.columns, 3);
    const last = plan.rooms.slice(6);
    assert.ok(Math.abs(last[0].x + last[1].x) < 1e-9);
    assert.ok(last[0].x < last[1].x);
  });

  test('a narrow viewport adds front floor for each room name list', () => {
    const wide = planOffice(rooms(4, 2), 1600 / 900);
    const phone = planOffice(rooms(4, 2), 390 / 844);
    assert.ok(phone.rooms[0].depth > wide.rooms[0].depth);
    const deskZ = (plan: OfficePlan) => plan.rooms[0].desks[0].z - plan.rooms[0].z;
    assert.ok(
      Math.abs(deskZ(phone) - deskZ(wide) + (phone.rooms[0].depth - wide.rooms[0].depth) / 2) <
        1e-9,
    );
  });

  test('desks stay inside their room and never share a spot', () => {
    const plan = planOffice([room('a', 1), room('b', 6), room('c', 3)], 16 / 9);
    for (const r of plan.rooms) {
      const spots = new Set(r.desks.map((d) => `${d.x.toFixed(3)},${d.z.toFixed(3)}`));
      assert.equal(spots.size, r.desks.length);
      for (const d of r.desks) {
        assert.ok(Math.abs(d.x - r.x) < r.width / 2, `desk x outside ${r.id}`);
        assert.ok(Math.abs(d.z - r.z) < r.depth / 2, `desk z outside ${r.id}`);
      }
    }
  });

  test('a lone desk is centred in its room', () => {
    const plan = planOffice([room('a', 1), room('b', 3)], 16 / 9);
    assert.equal(plan.rooms[0].desks[0].x, plan.rooms[0].x);
  });

  test('every room is sized for the fullest one', () => {
    const plan = planOffice([room('a', 1), room('b', 6)], 16 / 9);
    assert.equal(plan.rooms[0].width, plan.rooms[1].width);
    assert.equal(plan.rooms[0].depth, plan.rooms[1].depth);
  });

  test('an empty office still plans', () => {
    const plan = planOffice([], 1);
    assert.deepEqual(plan.rooms, []);
  });
});
