/**
 * The hero's staged story, as a pure function of a step counter:
 *   step 1      an invoice arrives, with the work attached to it
 *   steps 2–7   Veyrafy takes that work away, one task at a time; one task turns into a decision
 *   step 8      the decision is put in front of the team
 *   step 9      settled: the work is gone, one decision is left
 * All data is illustrative.
 */
export type TaskStatus = 'todo' | 'done' | 'decision';

export interface HeroTask {
  id: string;
  label: string;
  outcome: Exclude<TaskStatus, 'todo'>;
}

export const HERO_TASKS: readonly HeroTask[] = [
  { id: 'read', label: 'Read the invoice', outcome: 'done' },
  { id: 'key', label: 'Key in 14 fields', outcome: 'done' },
  { id: 'totals', label: 'Check the totals add up', outcome: 'done' },
  { id: 'order', label: 'Find the matching order', outcome: 'done' },
  { id: 'received', label: 'Compare with what was received', outcome: 'decision' },
  { id: 'chase', label: 'Chase someone for a sign-off', outcome: 'done' },
];

const N = HERO_TASKS.length;
export const HERO_STEPS = N + 3;

export interface HeroState {
  arrived: boolean;
  tasks: { task: HeroTask; status: TaskStatus }[];
  /** Tasks still standing: not yet taken away, or turned into a decision. */
  remaining: number;
  showDecision: boolean;
  settled: boolean;
}

export function heroStateAt(step: number): HeroState {
  const s = Math.max(0, Math.min(step, HERO_STEPS));
  const resolved = Math.max(0, Math.min(s - 1, N));
  const tasks = HERO_TASKS.map((task, i) => ({
    task,
    status: (i < resolved ? task.outcome : 'todo') as TaskStatus,
  }));
  return {
    arrived: s >= 1,
    tasks,
    remaining: tasks.filter((t) => t.status !== 'done').length,
    showDecision: s >= N + 2,
    settled: s >= N + 3,
  };
}
