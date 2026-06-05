import {
  AggregatedErrorDisplayParts,
  formatAggregatedErrors,
  getAggregatedErrorDisplayParts
} from './ErrorAggregatorDisplay';

export type { AggregatedErrorDisplayParts } from './ErrorAggregatorDisplay';

/**
 * ErrorAggregator collects multiple configuration errors so callers can report
 * all failures together instead of stopping at the first one.
 */
export class ErrorAggregator {
  private errors: Map<string, string> = new Map();

  /**
   * Adds an error to the collection
   * @param operation - Which operation failed (e.g., "Git configuration", "VSCode configuration")
   * @param error - Error details
   */
  addError(operation: string, error: string): void {
    this.errors.set(operation, error);
  }

  /**
   * Checks if any errors were collected
   * @returns true if errors exist
   */
  hasErrors(): boolean {
    return this.errors.size > 0;
  }

  /**
   * Formats all errors into user-friendly message with structured output.
   * @returns Formatted error message with troubleshooting steps
   */
  formatErrors(): string {
    return formatAggregatedErrors(this.errors);
  }

  /**
   * Formats errors as structured display parts so callers do not need to parse
   * localized strings to split the message from suggestions.
   */
  getDisplayParts(): AggregatedErrorDisplayParts {
    return getAggregatedErrorDisplayParts(this.errors);
  }

  /**
   * Clears all collected errors
   */
  clear(): void {
    this.errors.clear();
  }
}
