# 3D office

## Design choices

- **Model first, pure.** `deriveOffice` turns the live `OfficeState` characters into rooms (one per tmux
  session, natural order, Background last) of desks with helpers. Status comes from one first-match table.
  `planOffice` is a pure function of room shapes and viewport aspect. Both are covered by vitest.
- **Rooms are configurable.** `PIXEL_AGENTS_OFFICE_ROOMS=emperor-*` on the server (globs, comma or space
  separated) makes only matching tmux sessions rooms. The server lists sessions read-only every 2 s and
  sends `officeRooms`, so a matching session keeps its room even with nobody in it. Every other agent, and
  any agent without tmux, works at a smaller desk in the Background strip behind the rooms; clicking it
  still opens its terminal. Without the setting every session is a room.
- **Feeding the scene.** `OfficeState` is mutated in place and never re-renders React, so `Office3D` polls
  it every 250 ms and pushes a snapshot only when a JSON signature changes. The scene never reads React state.
- **Status reads from the overview without hovering.** Each status has a colour and a shape. Working
  types at a lit screen in calm blue; done shows a green check; idle has a dim screen and a grey label.
  Waiting-input gets a violet "?" badge, ring and room heat. Needs-permission gets an amber beam rising
  5 m above the room (the one cue that survives every zoom), a pulsing ring, a "!" badge, a filled label
  and a hot room floor, edge and label.
- **Find emperor-8 fast.** `OFFICE3D_PINNED_ROOMS` gives that room an accent label with a diamond.
  - The room bar at the top lists every room; a button or a room label glides the camera there.
  - The `#room` hash focuses a room on load and follows back/forward.
- **Labels are DOM, not textures.** `CSS2DRenderer` keeps names crisp at any DPR and makes them real
  buttons with focus rings. Density follows measured pixels per metre: full (name and activity), compact
  (name only), or roster, a per-room name list at the room front that keeps the phone view readable.
  Narrow viewports get extra front floor for that list and a steeper camera.
- **The monitor face** is a `CanvasTexture` painted by `paintScreen(canvas, lines, accent, lit)`; the lines
  are status and activity today, and live pane text can be fed through the same call.
- **Look:** standard PBR materials, a `RoomEnvironment` through PMREM, a key light with 2048 PCF shadows
  (radius 5), ACES tone mapping and sRGB output. Figures, desks, chairs and plants are built from three
  primitives; shirts follow the agent palette and hue shift. The dark pixel chrome is kept for the bar and
  labels, and the desk labels use a sans face for legibility.
- **Frame budget:**
  - Render on demand: continuous frames only while the camera moves or tweens; 30 fps timers while
    something animates; nothing otherwise.
  - DPR is capped at 2, rendering pauses on `visibilitychange`, and every geometry, material, texture,
    target and listener is disposed on unmount.
- **Clicks mirror the 2D view:** dismiss the bubble, toggle selection, then call `App.handleClick`, so the
  `TerminalPanel` opens the same way and sub-agents route to their parent. Only a drag past 6 px or a wheel
  counts as steering; a click must not freeze the auto-fit.

## Tried and dropped

- A "dots" density: unreadable at phone size, so it became the per-room roster.
- A full-height permission beam: it hid the figure it marks. The beam now fades out around head height.
- 10 px pixel-font desk labels: too small; the global pixel font is overridden for the 3D labels.
- Phone polar 0.6: rooms overlapped their own lists. 0.5 together with the roster floor works.
- A left-aligned last row of rooms: centred reads as deliberate.
- OrbitControls `start` as the "user moved" signal: it fires on every click and froze the auto-fit.

## Known weaknesses

- Every room is sized for the largest one, so a one-desk room wastes floor next to a four-desk room.
- The 2D game loop does not run under 3D, so despawned characters stay in `OfficeState` (they are
  hidden). A done or waiting bubble stays until the desk is clicked or the agent resumes; that is
  deliberate for "needs the owner", but it differs from the 2-second fade in the pixel view.
- The layout editor and the first-run tour fall back to the pixel view.
- Geometry dimensions are inline in `assets.ts` rather than in `constants.ts`.
- In the overview the "!" badge can sit under its room label; the beam above the room compensates.
- On phones a roster name longer than the room plus half the gap is ellipsised.
- The Office3D chunk is about 600 kB (lazy-loaded) and trips Vite's chunk-size warning.
- Frame rates were only seen under SwiftShader, so real-GPU performance is not measured.
- A viewer holding the server token gets the first-run tour, which shows the pixel view, and its game loop
  fades a done bubble in 2 seconds. Viewers behind Access never get the tour.
