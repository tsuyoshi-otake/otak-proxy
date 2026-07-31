import {
  AggregatedErrorDisplayParts,
  formatAggregatedErrors,
  getAggregatedErrorDisplayParts
} from './ErrorAggregatorDisplay';

export type { AggregatedErrorDisplayParts } from './ErrorAggregatorDisplay';

export interface AggregatedError {
  operation: string;
  error: string;
  errorType?: string;
}

/**
 * ErrorAggregator collects multiple configuration errors so callers can report
 * all failures together instead of stopping at the first one.
 */
export class ErrorAggregator {
  private errors: Map<string, string> = new Map();
  private errorTypes: Map<string, string> = new Map();

  /**
   * Adds an error to the collection
   * @param operation - Which operation failed (e.g., "Git configuration", "VSCode configuration")
   * @param error - Error details
   * @param errorType - Structured error classification for retry decisions
   */
  addError(operation: string, error: string, errorType?: string): void {
    this.errors.set(operation, error);
    if (errorType) {
      this.errorTypes.set(operation, errorType);
    } else {
      this.errorTypes.delete(operation);
    }
  }

  /**
   * Checks if any errors were collected
   * @returns true if errors exist
   */
  hasErrors(): boolean {
    return this.errors.size > 0;
  }

  getErrors(): AggregatedError[] {
    return Array.from(this.errors.entries()).map(([operation, error]) => {
      const errorType = this.errorTypes.get(operation);
      return errorType
        ? { operation, error, errorType }
        : { operation, error };
    });
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
    this.errorTypes.clear();
  }
}
