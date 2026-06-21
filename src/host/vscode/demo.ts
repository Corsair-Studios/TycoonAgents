/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

import type { Runtime } from "./runtime";
import type { ActivityKind } from "../../core/events";

const STEP_MS = 700;

/**
 * Run a scripted demo sequence through the runtime so the canvas renderer
 * can be exercised without live Claude Code hooks.
 *
 * NOTE: TaskCompleted events are synthesized here for the demo. The live
 * ClaudeCodeProvider does not emit TaskCompleted yet — that's a known gap
 * tracked for a future provider update.
 */
export function runDemo(runtime: Runtime): { dispose(): void } {
  const timers: ReturnType<typeof setTimeout>[] = [];
  let interval: ReturnType<typeof setInterval> | undefined;

  let t = 0;
  function after(delaySteps: number, fn: () => void): void {
    timers.push(setTimeout(fn, delaySteps * STEP_MS));
  }

  const now = () => Date.now();

  // 1. Session start
  after(t++, () => runtime.ingest({ type: "SessionStart", at: now() }));

  // 2. Spawn orchestrator
  after(t++, () =>
    runtime.ingest({ type: "WorkerSpawned", at: now(), workerId: "orchestrator", role: "orchestrator" })
  );

  // 3. Spawn two sub-workers
  after(t++, () =>
    runtime.ingest({ type: "WorkerSpawned", at: now(), workerId: "worker-1", role: "Task" })
  );
  after(t++, () =>
    runtime.ingest({ type: "WorkerSpawned", at: now(), workerId: "worker-2", role: "Task" })
  );

  // 4. Cycle activities for orchestrator and subs
  const activityCycle: ActivityKind[] = ["survey", "build", "haul", "wire", "shell"];
  let cycleIdx = 0;

  // Start cycling activity after initial spawns settle
  const activityStart = t;
  after(activityStart, () => {
    interval = setInterval(() => {
      const kind = activityCycle[cycleIdx % activityCycle.length];
      cycleIdx++;
      runtime.ingest({ type: "WorkerActivity", at: now(), workerId: "orchestrator", kind });
      runtime.ingest({ type: "WorkerActivity", at: now(), workerId: "worker-1", kind: activityCycle[(cycleIdx + 1) % activityCycle.length] });
      runtime.ingest({ type: "WorkerActivity", at: now(), workerId: "worker-2", kind: activityCycle[(cycleIdx + 2) % activityCycle.length] });
    }, STEP_MS);
  });

  // 5. Emit a few TaskCompleted events to drive build progress
  for (let i = 0; i < 5; i++) {
    const workerIdx = i % 2 === 0 ? "worker-1" : "worker-2";
    after(t + 3 + i * 2, () =>
      runtime.ingest({ type: "TaskCompleted", at: now(), workerId: workerIdx, label: `task-${i + 1}` })
    );
  }

  // 6. Stop sub-workers
  const stopAt = t + 16;
  after(stopAt, () => runtime.ingest({ type: "WorkerStopped", at: now(), workerId: "worker-1" }));
  after(stopAt + 1, () => runtime.ingest({ type: "WorkerStopped", at: now(), workerId: "worker-2" }));

  // 7. Session stop
  after(stopAt + 2, () => {
    if (interval) {
      clearInterval(interval);
      interval = undefined;
    }
    runtime.ingest({ type: "WorkerStopped", at: now(), workerId: "orchestrator" });
    runtime.ingest({ type: "SessionStop", at: now() });
  });

  return {
    dispose() {
      for (const t of timers) clearTimeout(t);
      if (interval) clearInterval(interval);
    },
  };
}
