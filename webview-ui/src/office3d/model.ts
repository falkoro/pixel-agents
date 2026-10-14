import type { Character, ToolActivity } from '../office/types.js';

export type DeskStatus = 'working' | 'needs-permission' | 'waiting-input' | 'done' | 'idle';

export interface HelperModel {
  agentId: number;
  status: DeskStatus;
  tool: string | null;
}

export interface DeskModel {
  agentId: number;
  name: string;
  pane: { session: string; windowId: string; paneId: string } | null;
  status: DeskStatus;
  tool: string | null;
  contextRatio: number;
  helpers: HelperModel[];
}

/** What the office reads from an AgentTerminalMeta, declared here so tests stay DOM-free. */
export interface TerminalMeta {
  name: string | null;
  tmux: DeskModel['pane'];
}

export interface RoomModel {
  id: string;
  title: string;
  desks: DeskModel[];
}

/** tmux turns ':' in a session name into '_', so this id never collides with a session. */
export const UNATTACHED_ROOM_ID = ':unattached';
export const UNATTACHED_ROOM_TITLE = 'Unattached';

export const STATUS_TEXT: Record<DeskStatus, string> = {
  working: 'Working',
  'needs-permission': 'Needs permission',
  'waiting-input': 'Waiting for you',
  done: 'Done',
  idle: 'Idle',
};

/** Desks that need the owner, most urgent first. */
export const ATTENTION_STATUSES: readonly DeskStatus[] = ['needs-permission', 'waiting-input'];

type StatusInput = Pick<Character, 'bubbleType' | 'waitingAwaitingInput' | 'isActive'>;

// First match wins. Active sits above the waiting rows because the office only
// fades a turn-end bubble in its 2D game loop: when the agent starts its next
// turn, a stale 'waiting' bubble must not keep it looking finished.
const STATUS_TABLE: ReadonlyArray<readonly [(c: StatusInput) => boolean, DeskStatus]> = [
  [(c) => c.bubbleType === 'permission', 'needs-permission'],
  [(c) => c.isActive, 'working'],
  [(c) => c.bubbleType === 'waiting' && c.waitingAwaitingInput === true, 'waiting-input'],
  [(c) => c.bubbleType === 'waiting', 'done'],
];

export function deskStatus(c: StatusInput): DeskStatus {
  return STATUS_TABLE.find(([matches]) => matches(c))?.[1] ?? 'idle';
}

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Natural order: `emperor-2` before `emperor-10`. */
export const naturalCompare = (a: string, b: string): number => natural.compare(a, b);

function activityText(
  ch: Character,
  tools: ToolActivity[] | undefined,
  status: DeskStatus,
): string | null {
  if (tools && tools.length > 0) {
    const open = [...tools].reverse().find((t) => !t.done);
    if (open) return open.status;
    if (status === 'working') return tools[tools.length - 1].status;
  }
  return status === 'working' ? ch.currentTool : null;
}

/**
 * Turn the live character map into rooms of desks: one room per tmux session in
 * natural order, then one room for top-level agents without a pane. Sub-agents
 * ride along as helpers of their parent's desk. `agentTools` supplies the human
 * activity label ("Reading App.tsx"); without it the bare tool name is used.
 */
export function deriveOffice(
  chars: Iterable<Character>,
  terminals: Record<number, TerminalMeta>,
  agentTools: Record<number, ToolActivity[]> = {},
): RoomModel[] {
  const desks = new Map<number, DeskModel>();
  const subagents: Character[] = [];

  for (const ch of chars) {
    if (ch.matrixEffect === 'despawn') continue;
    if (ch.isSubagent) {
      subagents.push(ch);
      continue;
    }
    const meta = terminals[ch.id];
    const status = deskStatus(ch);
    desks.set(ch.id, {
      agentId: ch.id,
      name: meta?.name || ch.sessionName || ch.folderName || `Agent ${ch.id}`,
      pane: meta ? meta.tmux : (ch.tmux ?? null),
      status,
      tool: activityText(ch, agentTools[ch.id], status),
      contextRatio:
        ch.maxContextTokens > 0
          ? Math.min(1, Math.max(0, ch.contextTokens / ch.maxContextTokens))
          : 0,
      helpers: [],
    });
  }

  for (const sub of subagents.sort((a, b) => b.id - a.id)) {
    const parent = sub.parentAgentId === null ? undefined : desks.get(sub.parentAgentId);
    if (!parent) continue;
    parent.helpers.push({ agentId: sub.id, status: deskStatus(sub), tool: sub.currentTool });
  }

  const bySession = new Map<string, DeskModel[]>();
  const unattached: DeskModel[] = [];
  for (const desk of desks.values()) {
    if (!desk.pane) {
      unattached.push(desk);
      continue;
    }
    const list = bySession.get(desk.pane.session) ?? [];
    list.push(desk);
    bySession.set(desk.pane.session, list);
  }

  const paneOrder = (a: DeskModel, b: DeskModel): number =>
    naturalCompare(a.pane?.windowId ?? '', b.pane?.windowId ?? '') ||
    naturalCompare(a.pane?.paneId ?? '', b.pane?.paneId ?? '') ||
    a.agentId - b.agentId;

  const rooms: RoomModel[] = [...bySession.keys()].sort(naturalCompare).map((session) => ({
    id: session,
    title: session,
    desks: (bySession.get(session) ?? []).sort(paneOrder),
  }));
  if (unattached.length > 0) {
    rooms.push({
      id: UNATTACHED_ROOM_ID,
      title: UNATTACHED_ROOM_TITLE,
      desks: unattached.sort((a, b) => a.agentId - b.agentId),
    });
  }
  return rooms;
}

/** The most urgent status in a room, used to heat its floor and label. */
export function roomHeat(room: RoomModel): DeskStatus | null {
  for (const status of ATTENTION_STATUSES) {
    if (room.desks.some((d) => d.status === status || d.helpers.some((h) => h.status === status))) {
      return status;
    }
  }
  return null;
}
