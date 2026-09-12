/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
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

  // 2. Spawn orchestrator with real identity
  after(t++, () =>
    runtime.ingest({
      type: "WorkerSpawned",
      at: now(),
      workerId: "orchestrator",
      role: "orchestrator",
      model: "Opus",
      description: "Coordinates work and delegates to specialists.",
    })
  );

  // 3. Spawn real sub-agents with identities
  after(t++, () =>
    runtime.ingest({
      type: "WorkerSpawned",
      at: now(),
      workerId: "primary-agent",
      role: "Task",
      name: "Wildcard Agent",
      model: "Sonnet",
      description: "Handles tasks that don't match any other agent's keywords.",
    })
  );
  after(t++, () =>
    runtime.ingest({
      type: "WorkerSpawned",
      at: now(),
      workerId: "search-retrieval",
      role: "Task",
      model: "Haiku",
      description: "Fast code search, file finding, and lookups.",
    })
  );
  after(t++, () =>
    runtime.ingest({
      type: "WorkerSpawned",
      at: now(),
      workerId: "coding-specialist",
      role: "Task",
      model: "Sonnet",
      description: "Core implementation in src/core and src/providers.",
    })
  );

  // 4. Cycle activities for all agents (staggered so each hits "wire" regularly)
  const activityCycle: ActivityKind[] = ["survey", "build", "haul", "wire", "shell"];
  let cycleIdx = 0;

  // Start cycling activity after initial spawns settle
  const activityStart = t;
  after(activityStart, () => {
    interval = setInterval(() => {
      const kind = activityCycle[cycleIdx % activityCycle.length];
      cycleIdx++;
      runtime.ingest({ type: "WorkerActivity", at: now(), workerId: "orchestrator", kind });
      runtime.ingest({ type: "WorkerActivity", at: now(), workerId: "primary-agent", kind: activityCycle[(cycleIdx + 1) % activityCycle.length] });
      runtime.ingest({ type: "WorkerActivity", at: now(), workerId: "search-retrieval", kind: activityCycle[(cycleIdx + 2) % activityCycle.length] });
      runtime.ingest({ type: "WorkerActivity", at: now(), workerId: "coding-specialist", kind: activityCycle[(cycleIdx + 3) % activityCycle.length] });
    }, STEP_MS);
  });

  // 5. Emit TaskCompleted events spread across all four agents
  const taskAgents = ["primary-agent", "search-retrieval", "coding-specialist", "orchestrator", "primary-agent", "coding-specialist"];
  for (let i = 0; i < taskAgents.length; i++) {
    const workerId = taskAgents[i];
    after(t + 3 + i * 2, () =>
      runtime.ingest({ type: "TaskCompleted", at: now(), workerId, label: `task-${i + 1}` })
    );
  }

  // 6. Stop sub-agents with token counts
  const stopAt = t + 18;
  after(stopAt, () => runtime.ingest({ type: "WorkerStopped", at: now(), workerId: "search-retrieval", tokens: 450 }));
  after(stopAt + 1, () => runtime.ingest({ type: "WorkerStopped", at: now(), workerId: "primary-agent", tokens: 800 }));
  after(stopAt + 2, () => runtime.ingest({ type: "WorkerStopped", at: now(), workerId: "coding-specialist", tokens: 2100 }));

  // 7. Session stop
  after(stopAt + 3, () => {
    if (interval) {
      clearInterval(interval);
      interval = undefined;
    }
    runtime.ingest({ type: "WorkerStopped", at: now(), workerId: "orchestrator", tokens: 1200 });
    runtime.ingest({ type: "SessionStop", at: now() });
  });

  return {
    dispose() {
      for (const t of timers) clearTimeout(t);
      if (interval) clearInterval(interval);
    },
  };
}
