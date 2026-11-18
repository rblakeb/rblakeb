// Types for behaviorEvents.js, so the server's TypeScript tests can import it.
export interface BehaviorFrame {
  t: number;
  faceVisible: boolean;
  smile?: number;
  jawOpen?: number;
  yawDeg?: number;
  gesture?: string | null;
}
export class BehaviorDetector {
  constructor(onEvent: (kind: string) => void);
  update(frame: BehaviorFrame): void;
}
export function yawFromMatrix(data: number[]): number;
