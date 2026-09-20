import type { GateContext, GateOutcome } from "./types.js";

/**
 * One stage of the permission pipeline.
 *
 * A gate either decides the request, asks the caller, or abstains by returning
 * undefined so that the next gate gets a chance to weigh in.
 */
export abstract class PermissionGate {
  abstract readonly name: string;

  /** undefined = pass the request on to the next gate. */
  abstract evaluate(context: GateContext): Promise<GateOutcome | undefined>;
}
