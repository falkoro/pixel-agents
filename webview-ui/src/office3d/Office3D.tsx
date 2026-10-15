import './office3d.css';

import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { OfficeRooms } from '../../../core/src/messages.js';
import { OFFICE3D_PINNED_ROOMS, OFFICE3D_POLL_MS, OFFICE3D_STATUS_COLORS } from '../constants.js';
import type { AgentTerminalMeta } from '../hooks/useExtensionMessages.js';
import type { OfficeState } from '../office/engine/officeState.js';
import type { ToolActivity } from '../office/types.js';
import type { Look } from './assets.js';
import type { RoomModel } from './model.js';
import { deriveOffice, roomHeat } from './model.js';
import { OfficeScene } from './scene.js';
import { cssColor } from './screen.js';

interface Office3DProps {
  officeState: OfficeState;
  agentTerminals: Record<number, AgentTerminalMeta>;
  agentTools: Record<number, ToolActivity[]>;
  officeRooms: OfficeRooms | null;
  onClick: (agentId: number) => void;
}

const STATUS_VARS = Object.fromEntries(
  Object.entries(OFFICE3D_STATUS_COLORS).map(([status, hex]) => [`--o3d-${status}`, cssColor(hex)]),
) as CSSProperties;

/**
 * The 3D office view. OfficeState is mutated in place by the message handler
 * and never re-renders React, so the scene is fed by a light poll that only
 * pushes a new snapshot when something visible changed.
 */
export default function Office3D(props: Office3DProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [rooms, setRooms] = useState<RoomModel[]>([]);
  const [focused, setFocused] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const scene = new OfficeScene(host, {
      onPick: (id) => {
        // Same toggle the 2D canvas makes before it reports a click.
        const { officeState: os, onClick } = latest.current;
        os.dismissBubble(id);
        // The pixel view finishes a dismissed fade in its game loop, which does
        // not run here. Without this a looked-at desk would stay done forever.
        const ch = os.characters.get(id);
        if (ch?.bubbleType === 'waiting') {
          ch.bubbleType = null;
          ch.bubbleTimer = 0;
        }
        const deselect = os.selectedAgentId === id;
        os.selectedAgentId = deselect ? null : id;
        os.cameraFollowId = deselect ? null : id;
        onClick(id);
        poll();
      },
      onFocus: setFocused,
    });
    sceneRef.current = scene;

    let last = '';
    function poll(): void {
      if (document.hidden) return;
      const { officeState: os, agentTerminals, agentTools, officeRooms } = latest.current;
      const next = deriveOffice(os.characters.values(), agentTerminals, agentTools, officeRooms);
      const looks = new Map<number, Look>();
      for (const ch of os.characters.values()) {
        looks.set(ch.id, { palette: ch.palette, hueShift: ch.hueShift });
      }
      const signature = JSON.stringify([next, [...looks], os.selectedAgentId]);
      if (signature === last) return;
      last = signature;
      scene.update({ rooms: next, looks, selectedId: os.selectedAgentId });
      setRooms(next);
    }
    poll();
    const timer = window.setInterval(poll, OFFICE3D_POLL_MS);
    return () => {
      window.clearInterval(timer);
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  return (
    <div className="o3d-root" style={STATUS_VARS}>
      <div ref={hostRef} className="o3d-host" />
      <nav className="o3d-bar" aria-label="Rooms">
        <button
          type="button"
          className="o3d-bar-btn"
          aria-pressed={focused === null}
          onClick={() => sceneRef.current?.focusRoom(null)}
        >
          All
        </button>
        {rooms.map((room) => (
          <button
            key={room.id}
            type="button"
            className="o3d-bar-btn"
            aria-pressed={focused === room.id}
            data-heat={roomHeat(room) ?? 'calm'}
            data-pinned={OFFICE3D_PINNED_ROOMS.includes(room.id) || undefined}
            onClick={() => sceneRef.current?.focusRoom(room.id)}
          >
            {room.title}
          </button>
        ))}
      </nav>
    </div>
  );
}
