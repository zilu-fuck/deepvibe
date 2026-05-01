import { randomUUID } from "node:crypto";

import { runEngine, type EngineEvent, type RunEngineDependencies, type RunEngineOptions } from "./engine.js";

export type TaskStatus = "running" | "completed" | "failed" | "canceled";

export interface ServiceTaskEvent {
  id: number;
  payload?: Record<string, unknown>;
  source: "task" | "engine";
  status: TaskStatus;
  taskId: string;
  terminal: boolean;
  timestamp: string;
  type: string;
  version: 1;
}

export interface ServiceTaskSnapshot {
  error?: string;
  result?: unknown;
  status: TaskStatus;
  taskId: string;
}

interface ManagedTask {
  abortController: AbortController;
  events: ServiceTaskEvent[];
  listeners: Set<(event: ServiceTaskEvent) => void>;
  nextEventId: number;
  result?: unknown;
  error?: string;
  status: TaskStatus;
  taskId: string;
}

export class TaskManager {
  private readonly tasks = new Map<string, ManagedTask>();

  createRunTask(
    options: RunEngineOptions,
    dependencies: RunEngineDependencies,
    executeRunEngine: typeof runEngine = runEngine
  ): ServiceTaskSnapshot {
    const taskId = randomUUID();
    const task: ManagedTask = {
      abortController: new AbortController(),
      events: [],
      listeners: new Set(),
      nextEventId: 1,
      status: "running",
      taskId
    };

    this.tasks.set(taskId, task);
    this.emit(task, "task.started", {
      instruction: options.instruction
    }, "task");

    void executeRunEngine(options, {
      ...dependencies,
      abortSignal: task.abortController.signal,
      emitEvent: (event: EngineEvent) => {
        this.emit(task, event.type, event.payload, "engine");
      }
    })
      .then((result) => {
        task.status = "completed";
        task.result = result;
        this.emit(task, "task.completed", {
          message: result.message,
          result
        }, "task");
      })
      .catch((error) => {
        if (task.abortController.signal.aborted) {
          task.status = "canceled";
          task.error = error instanceof Error ? error.message : "Execution canceled.";
          this.emit(task, "task.canceled", {
            error: task.error,
            message: task.error
          }, "task");
          return;
        }

        task.status = "failed";
        task.error = error instanceof Error ? error.message : "Execution failed.";
        this.emit(task, "task.failed", {
          error: task.error,
          message: task.error
        }, "task");
      });

    return this.getTaskSnapshot(taskId)!;
  }

  cancelTask(taskId: string): ServiceTaskSnapshot {
    const task = this.tasks.get(taskId);

    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }

    if (task.status !== "running") {
      return this.snapshot(task);
    }

    task.abortController.abort();
    this.emit(task, "task.cancel_requested", undefined, "task");

    return this.snapshot(task);
  }

  getTaskSnapshot(taskId: string): ServiceTaskSnapshot | undefined {
    const task = this.tasks.get(taskId);

    return task ? this.snapshot(task) : undefined;
  }

  getTaskEvents(taskId: string): ServiceTaskEvent[] | undefined {
    return this.tasks.get(taskId)?.events;
  }

  subscribe(taskId: string, listener: (event: ServiceTaskEvent) => void): (() => void) | undefined {
    const task = this.tasks.get(taskId);

    if (!task) {
      return undefined;
    }

    task.listeners.add(listener);

    return () => {
      task.listeners.delete(listener);
    };
  }

  private emit(task: ManagedTask, type: string, payload: Record<string, unknown> | undefined, source: "task" | "engine"): void {
    const event: ServiceTaskEvent = {
      id: task.nextEventId++,
      source,
      status: task.status,
      taskId: task.taskId,
      terminal: task.status === "completed" || task.status === "failed" || task.status === "canceled",
      timestamp: new Date().toISOString(),
      type,
      payload,
      version: 1
    };

    task.events.push(event);

    for (const listener of task.listeners) {
      listener(event);
    }
  }

  private snapshot(task: ManagedTask): ServiceTaskSnapshot {
    return {
      taskId: task.taskId,
      status: task.status,
      result: task.result,
      error: task.error
    };
  }
}
