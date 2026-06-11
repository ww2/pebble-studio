export interface TouchSpec {
  x: number; y: number;
  kind: "tap" | "down" | "move" | "up";
  width: number; height: number;
}
export interface QmpMessage {
  execute: "input-send-event";
  arguments: { events: any[] };
}

const ABS_MAX = 0x7fff;
function absAxis(axis: "x" | "y", value: number, span: number) {
  return { type: "abs", data: { axis, value: Math.round((value / span) * ABS_MAX) } };
}
function btn(down: boolean) {
  return { type: "btn", data: { down, button: "left" } };
}

export function touchEvent(spec: TouchSpec): QmpMessage[] {
  const move: QmpMessage = {
    execute: "input-send-event",
    arguments: { events: [absAxis("x", spec.x, spec.width), absAxis("y", spec.y, spec.height)] },
  };
  if (spec.kind === "move") return [move];
  if (spec.kind === "down") return [move, { execute: "input-send-event", arguments: { events: [btn(true)] } }];
  if (spec.kind === "up") return [move, { execute: "input-send-event", arguments: { events: [btn(false)] } }];
  // tap = move + down + up
  return [
    move,
    { execute: "input-send-event", arguments: { events: [btn(true)] } },
    { execute: "input-send-event", arguments: { events: [btn(false)] } },
  ];
}
