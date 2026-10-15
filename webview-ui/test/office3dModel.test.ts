import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import type { Character } from '../src/office/types.js';
import type { TerminalMeta } from '../src/office3d/model.js';
import { deriveOffice, deskStatus, LOUNGE_ROOM_ID, roomHeat } from '../src/office3d/model.js';

function char(id: number, extra: Partial<Character> = {}): Character {
  return {
    id,
    isActive: false,
    currentTool: null,
    bubbleType: null,
    isSubagent: false,
    parentAgentId: null,
    palette: 0,
    hueShift: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    matrixEffect: null,
    ...extra,
  } as Character;
}

function pane(session: string, windowId = '@1', paneId = '%1'): TerminalMeta['tmux'] {
  return { session, windowId, paneId };
}

describe('deskStatus', () => {
  test('maps each bubble and activity combination', () => {
    assert.equal(deskStatus(char(1, { bubbleType: 'permission' })), 'needs-permission');
    assert.equal(
      deskStatus(char(1, { bubbleType: 'waiting', waitingAwaitingInput: true })),
      'waiting-input',
    );
    assert.equal(deskStatus(char(1, { bubbleType: 'waiting' })), 'done');
    assert.equal(
      deskStatus(char(1, { bubbleType: 'waiting', waitingAwaitingInput: false })),
      'done',
    );
    assert.equal(deskStatus(char(1, { isActive: true })), 'working');
    assert.equal(deskStatus(char(1)), 'idle');
  });

  test('a permission request mid-turn outranks working', () => {
    assert.equal(
      deskStatus(char(1, { isActive: true, bubbleType: 'permission' })),
      'needs-permission',
    );
  });

  test('a new turn outranks the previous turn-end bubble', () => {
    assert.equal(deskStatus(char(1, { isActive: true, bubbleType: 'waiting' })), 'working');
  });
});

describe('deriveOffice', () => {
  test('groups agents into one room per tmux session in natural order', () => {
    const chars = [
      char(1, { tmux: pane('emperor-10') }),
      char(2, { tmux: pane('emperor-2') }),
      char(3, { tmux: pane('emperor-8') }),
      char(4, { tmux: pane('emperor-2', '@7') }),
    ];
    const rooms = deriveOffice(chars, {});
    assert.deepEqual(
      rooms.map((r) => r.id),
      ['emperor-2', 'emperor-8', 'emperor-10'],
    );
    assert.deepEqual(
      rooms[0].desks.map((d) => d.agentId),
      [2, 4],
    );
    assert.equal(rooms[0].title, 'emperor-2');
  });

  test('orders desks in a room by tmux window', () => {
    const chars = [
      char(1, { tmux: pane('s', '@12') }),
      char(2, { tmux: pane('s', '@3') }),
      char(3, { tmux: pane('s', '@3', '%9') }),
    ];
    const [room] = deriveOffice(chars, {});
    assert.deepEqual(
      room.desks.map((d) => d.agentId),
      [2, 3, 1],
    );
  });

  test('puts agents without tmux in one last room', () => {
    const chars = [
      char(5),
      char(1, { tmux: pane('zeta') }),
      char(3, { folderName: 'nightly' }),
      char(2, { tmux: pane('alpha') }),
    ];
    const rooms = deriveOffice(chars, {});
    assert.deepEqual(
      rooms.map((r) => r.id),
      ['alpha', 'zeta', LOUNGE_ROOM_ID],
    );
    const last = rooms[rooms.length - 1];
    assert.equal(last.title, 'Lounge');
    assert.deepEqual(
      last.desks.map((d) => d.agentId),
      [3, 5],
    );
    assert.equal(last.desks[0].pane, null);
  });

  test('no lounge when every agent has a pane', () => {
    const rooms = deriveOffice([char(1, { tmux: pane('a') })], {});
    assert.equal(rooms.length, 1);
  });

  test('terminal metadata wins over the character copy', () => {
    const chars = [char(1, { tmux: pane('stale'), sessionName: 'old' })];
    const terminals = { 1: { name: 'firstmate-b4', tmux: pane('emperor-8') } };
    const [room] = deriveOffice(chars, terminals);
    assert.equal(room.id, 'emperor-8');
    assert.equal(room.desks[0].name, 'firstmate-b4');
    assert.deepEqual(room.desks[0].pane, pane('emperor-8'));
  });

  test('a terminal entry with no pane sends the agent to the lounge', () => {
    const chars = [char(1, { tmux: pane('gone') })];
    const rooms = deriveOffice(chars, { 1: { name: null, tmux: null } });
    assert.equal(rooms[0].id, LOUNGE_ROOM_ID);
  });

  test('names fall back from registry name to folder to agent id', () => {
    const chars = [char(1, { sessionName: 'reg' }), char(2, { folderName: 'repo' }), char(3)];
    const desks = deriveOffice(chars, {})[0].desks;
    assert.deepEqual(
      desks.map((d) => d.name),
      ['reg', 'repo', 'Agent 3'],
    );
  });

  test('sub-agents become helpers of their parent and never get a desk', () => {
    const chars = [
      char(1, { tmux: pane('s'), isActive: true }),
      char(-1, { isSubagent: true, parentAgentId: 1, isActive: true, currentTool: 'Read' }),
      char(-2, { isSubagent: true, parentAgentId: 1, bubbleType: 'permission' }),
      char(-3, { isSubagent: true, parentAgentId: 99 }),
    ];
    const rooms = deriveOffice(chars, {});
    assert.equal(rooms.length, 1);
    assert.equal(rooms[0].desks.length, 1);
    assert.deepEqual(rooms[0].desks[0].helpers, [
      { agentId: -1, status: 'working', tool: 'Read' },
      { agentId: -2, status: 'needs-permission', tool: null },
    ]);
  });

  test('despawning characters are already gone', () => {
    const rooms = deriveOffice([char(1, { matrixEffect: 'despawn' })], {});
    assert.deepEqual(rooms, []);
  });

  test('activity text comes from the open tool, then the last one while working', () => {
    const chars = [
      char(1, { isActive: true, currentTool: 'Read' }),
      char(2, { isActive: true, currentTool: 'Edit' }),
      char(3, { isActive: true, currentTool: 'Bash' }),
      char(4, { currentTool: null }),
    ];
    const tools = {
      1: [
        { toolId: 'a', status: 'Reading App.tsx', done: true },
        { toolId: 'b', status: 'Editing model.ts', done: false },
      ],
      2: [{ toolId: 'c', status: 'Reading README.md', done: true }],
    };
    const desks = deriveOffice(chars, {}, tools)[0].desks;
    assert.deepEqual(
      desks.map((d) => d.tool),
      ['Editing model.ts', 'Reading README.md', 'Bash', null],
    );
  });

  test('an open question tool reads as waiting for you, an answered one as working', () => {
    const chars = [
      char(1, { isActive: true, currentTool: 'AskUserQuestion' }),
      char(2, { isActive: true, currentTool: 'AskUserQuestion' }),
      char(3, { isActive: true, bubbleType: 'permission' }),
    ];
    const tools = {
      1: [{ toolId: 'a', status: 'Waiting for your answer', done: false, question: true }],
      2: [{ toolId: 'b', status: 'Waiting for your answer', done: true, question: true }],
      3: [{ toolId: 'c', status: 'Waiting for your answer', done: false, question: true }],
    };
    const desks = deriveOffice(chars, {}, tools)[0].desks;
    assert.deepEqual(
      desks.map((d) => d.status),
      ['waiting-input', 'working', 'needs-permission'],
    );
  });

  test('context ratio is clamped and zero when the window is unknown', () => {
    const chars = [
      char(1, { contextTokens: 50, maxContextTokens: 200 }),
      char(2, { contextTokens: 300, maxContextTokens: 200 }),
      char(3, { contextTokens: 300, maxContextTokens: 0 }),
    ];
    const desks = deriveOffice(chars, {})[0].desks;
    assert.deepEqual(
      desks.map((d) => d.contextRatio),
      [0.25, 1, 0],
    );
  });
});

describe('roomHeat', () => {
  test('permission outranks waiting for input, which outranks calm', () => {
    const rooms = deriveOffice(
      [
        char(1, { tmux: pane('a'), bubbleType: 'waiting', waitingAwaitingInput: true }),
        char(2, { tmux: pane('a'), bubbleType: 'permission' }),
        char(3, { tmux: pane('b'), bubbleType: 'waiting', waitingAwaitingInput: true }),
        char(4, { tmux: pane('c'), isActive: true }),
        char(-1, { isSubagent: true, parentAgentId: 4, bubbleType: 'permission' }),
        char(5, { tmux: pane('d'), bubbleType: 'waiting' }),
      ],
      {},
    );
    assert.deepEqual(rooms.map(roomHeat), [
      'needs-permission',
      'waiting-input',
      'needs-permission',
      null,
    ]);
  });
});
