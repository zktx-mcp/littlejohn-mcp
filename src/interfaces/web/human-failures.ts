import type {
  FieldIssue,
} from "../../core/browser.js";
import type {
  BrowserErrorCode,
} from "../browser-error-response.js";
import { isBrowserErrorCode } from "../browser-error-response.js";
import {
  browserRequestFailure,
  type BrowserLocalFailureCode,
  type BrowserRequestFailure,
} from "./browser-client.js";

export const humanFailureTaskContexts = Object.freeze([
  "wallet_status",
  "wallet_connection",
  "wallet_disconnection",
  "assets_collection",
  "stock_token_candidates",
  "stock_token_information",
  "stock_token_change",
  "stock_token_add",
  "stock_token_remove",
  "prices_list",
  "selected_price",
  "price_history",
  "analysis",
] as const);

export type HumanFailureTaskContext =
  typeof humanFailureTaskContexts[number];

type HumanFailureCode = BrowserErrorCode | BrowserLocalFailureCode;

export interface CanonicalBrowserOperationFailure {
  readonly ok: false;
  readonly error: Readonly<{
    code: string;
    retryable: boolean;
    issues: readonly FieldIssue[];
  }>;
}

export type HumanFailureInput =
  | BrowserRequestFailure
  | CanonicalBrowserOperationFailure;

export interface HumanFailureFieldTarget {
  readonly label: string;
  readonly controlId: string;
  readonly errorId: string;
}

export interface HumanFailureFieldBinding
  extends HumanFailureFieldTarget {
  readonly path: string;
}

export type HumanFailureFieldMap =
  readonly HumanFailureFieldBinding[];

export interface HumanFailureFieldPresentation
  extends HumanFailureFieldTarget {
  readonly path: string;
  readonly summary: string;
}

export interface HumanFailurePresentation {
  readonly summary: string;
  readonly recovery?: string;
  readonly retryable: boolean;
  readonly fields: readonly HumanFailureFieldPresentation[];
  readonly code: HumanFailureCode;
}

interface HumanFailureFacts {
  readonly code: HumanFailureCode;
  readonly retryable: boolean;
  readonly issues: readonly FieldIssue[];
}

interface TaskCopy {
  readonly subject: string;
  readonly request: string;
}

const taskCopyByContext = new Map<
  HumanFailureTaskContext,
  TaskCopy
>([
  ["wallet_status", Object.freeze({
    subject: "Wallet status",
    request: "wallet status check",
  })],
  ["wallet_connection", Object.freeze({
    subject: "Wallet connection",
    request: "wallet connection",
  })],
  ["wallet_disconnection", Object.freeze({
    subject: "Wallet disconnection",
    request: "wallet disconnection",
  })],
  ["assets_collection", Object.freeze({
    subject: "Assets",
    request: "asset read",
  })],
  ["stock_token_candidates", Object.freeze({
    subject: "Stock Tokens",
    request: "Stock Token search",
  })],
  ["stock_token_information", Object.freeze({
    subject: "Stock Token information",
    request: "Stock Token information read",
  })],
  ["stock_token_change", Object.freeze({
    subject: "The Stock Token change",
    request: "Stock Token change",
  })],
  ["stock_token_add", Object.freeze({
    subject: "Adding the Stock Token",
    request: "Stock Token addition",
  })],
  ["stock_token_remove", Object.freeze({
    subject: "Removing the Stock Token",
    request: "Stock Token removal",
  })],
  ["prices_list", Object.freeze({
    subject: "Prices",
    request: "price read",
  })],
  ["selected_price", Object.freeze({
    subject: "The selected price",
    request: "selected price read",
  })],
  ["price_history", Object.freeze({
    subject: "Price history",
    request: "price history read",
  })],
  ["analysis", Object.freeze({
    subject: "Analysis",
    request: "analysis read",
  })],
]);

const taskCopyFor = (
  context: HumanFailureTaskContext,
): TaskCopy => {
  const copy = taskCopyByContext.get(context);
  if (copy === undefined) {
    throw new TypeError("Human failure task context is incomplete.");
  }
  return copy;
};

const failureFacts = (failure: HumanFailureInput): HumanFailureFacts => {
  if ("kind" in failure) {
    return failure.kind === "response_problem"
      ? Object.freeze({
          code: failure.problem.code,
          retryable: failure.problem.retryable,
          issues: failure.problem.issues,
        })
      : Object.freeze({
          code: failure.code,
          retryable: failure.retryable,
          issues: failure.issues,
        });
  }
  if (!isBrowserErrorCode(failure.error.code)) {
    throw new TypeError("Browser operation failure code is outside browser authority.");
  }
  return Object.freeze({
    code: failure.error.code,
    retryable: failure.error.retryable,
    issues: failure.error.issues,
  });
};

const assertNever = (value: never): never => {
  throw new TypeError(`Unhandled browser failure code: ${String(value)}`);
};

const copyForCode = (
  code: HumanFailureCode,
  task: TaskCopy,
  hasMappedFields: boolean,
): Readonly<{ summary: string; recovery?: string }> => {
  switch (code) {
    case "invalid_input":
      return hasMappedFields
        ? Object.freeze({
            summary: "Check the highlighted fields.",
          })
        : Object.freeze({
            summary: `${task.subject} could not start because the request was invalid.`,
            recovery: "Refresh or reopen this task before trying again.",
          });
    case "not_found":
      return Object.freeze({
        summary: `${task.subject} is no longer available.`,
        recovery: "Refresh or reopen this task.",
      });
    case "source_unavailable":
      return Object.freeze({
        summary: `${task.subject} could not be loaded because a required data source is unavailable.`,
        recovery: "Try again.",
      });
    case "source_inconsistent":
      return Object.freeze({
        summary: `Little John could not verify the data required for ${task.request}, so no result was accepted.`,
      });
    case "rate_limited":
      return Object.freeze({
        summary: `${task.subject} could not be loaded because a required data source is temporarily limiting requests.`,
        recovery: "Try again shortly.",
      });
    case "runtime_busy":
      return Object.freeze({
        summary: `${task.subject} could not be loaded because Little John is busy.`,
        recovery: "Try again.",
      });
    case "request_aborted":
      return Object.freeze({
        summary: `The ${task.request} stopped before it completed.`,
        recovery: "Try again when you are ready.",
      });
    case "response_timeout":
      return Object.freeze({
        summary: `Little John did not complete the ${task.request} in time.`,
        recovery: "Try again.",
      });
    case "wallet_timeout":
      return Object.freeze({
        summary: `${task.subject} did not complete before Little John's local action deadline.`,
      });
    case "runtime_state_unavailable":
      return Object.freeze({
        summary: `Little John is not available, so ${task.subject.toLowerCase()} could not be loaded.`,
        recovery: "Start or restart Little John, then reload this page.",
      });
    case "unauthorized":
      return Object.freeze({
        summary: "This local browser session is no longer valid.",
        recovery: "Reload the page to start a new local session.",
      });
    case "state_conflict":
    case "token_selection_revision_changed":
      return Object.freeze({
        summary: `${task.subject} changed before this request completed.`,
        recovery: "Refresh or reopen this task.",
      });
    case "token_operation_conflict":
      return Object.freeze({
        summary: "Another Stock Token change is already active.",
        recovery: "Finish or close the active change before trying again.",
      });
    case "token_operation_not_found":
      return Object.freeze({
        summary: "This Stock Token change is no longer available.",
        recovery: "Reopen the Stock Token task.",
      });
    case "token_operation_expired":
      return Object.freeze({
        summary: "This Stock Token review expired before it was confirmed.",
        recovery: "Reopen the Stock Token task.",
      });
    case "token_selection_already_included":
      return Object.freeze({
        summary: "This Stock Token is already included in Assets.",
        recovery: "Refresh Assets to see the current selection.",
      });
    case "token_selection_not_found":
    case "token_selection_not_included":
      return Object.freeze({
        summary: "This Stock Token is no longer included in Assets.",
        recovery: "Refresh Assets before continuing.",
      });
    case "token_total_supply_reverted":
      return Object.freeze({
        summary: `The token contract did not return the information required for ${task.request}.`,
      });
    case "wallet_not_connected":
      return Object.freeze({
        summary: `${task.subject} requires a connected Robinhood Wallet.`,
        recovery: "Connect the wallet, then try again.",
      });
    case "wallet_session_unusable":
      return Object.freeze({
        summary: "The current Robinhood Wallet state cannot complete this request.",
        recovery: "Disconnect every wallet session in this local profile, then connect the wallet again.",
      });
    case "wallet_pairing_code_unavailable":
      return Object.freeze({
        summary: "Little John could not create the wallet pairing code.",
      });
    case "walletconnect_unavailable":
      return Object.freeze({
        summary: `WalletConnect could not complete ${task.request}.`,
      });
    case "wallet_user_rejected":
      return Object.freeze({
        summary: "Robinhood Wallet did not approve this request.",
      });
    case "interactive_terminal_required":
      return Object.freeze({
        summary: `${task.subject} must be completed from an interactive command line.`,
      });
    case "result_too_large":
      return Object.freeze({
        summary: `${task.subject} returned more information than Little John can safely present.`,
      });
    case "invalid_response":
      return Object.freeze({
        summary: `Little John received an invalid local response while completing ${task.request}.`,
        recovery: "Reload the page before trying again.",
      });
    case "internal_error":
      return Object.freeze({
        summary: `Little John could not complete ${task.request}.`,
      });
    case "invalid_json":
    case "query_not_supported":
    case "payload_too_large":
    case "content_type_unsupported":
    case "route_not_found":
    case "method_not_allowed":
      return Object.freeze({
        summary: `The local request for ${task.subject.toLowerCase()} was rejected.`,
        recovery: "Reload the page before trying again.",
      });
    case "invalid_host":
    case "invalid_origin":
      return Object.freeze({
        summary: `Little John blocked the local request for ${task.subject.toLowerCase()}.`,
        recovery: "Open this task from the Little John local address.",
      });
    case "port_conflict":
      return Object.freeze({
        summary: `Little John cannot load ${task.subject.toLowerCase()} because its local address is in use by another process.`,
        recovery: "Close the conflicting process, restart Little John, and reload.",
      });
    default:
      return assertNever(code);
  }
};

const fieldPresentations = (
  issues: readonly FieldIssue[],
  fieldMap: HumanFailureFieldMap,
): readonly HumanFailureFieldPresentation[] => Object.freeze(
  issues.flatMap((issue) => {
    const target = fieldMap.find((binding) => binding.path === issue.path);
    return target === undefined
      ? []
      : [Object.freeze({
          path: issue.path,
          label: target.label,
          controlId: target.controlId,
          errorId: target.errorId,
          summary: `Check ${target.label}.`,
        })];
  }),
);

export const presentHumanFailure = (
  context: HumanFailureTaskContext,
  failure: HumanFailureInput,
  fieldMap: HumanFailureFieldMap = Object.freeze([]),
): HumanFailurePresentation => {
  const facts = failureFacts(failure);
  const fields = fieldPresentations(facts.issues, fieldMap);
  const copy = copyForCode(facts.code, taskCopyFor(context), fields.length > 0);
  return Object.freeze({
    summary: copy.summary,
    ...(copy.recovery === undefined ? {} : { recovery: copy.recovery }),
    retryable: facts.retryable,
    fields,
    code: facts.code,
  });
};

export const presentBrowserRequestFailure = (
  context: HumanFailureTaskContext,
  error: unknown,
  fieldMap?: HumanFailureFieldMap,
): HumanFailurePresentation => presentHumanFailure(
  context,
  browserRequestFailure(error),
  fieldMap,
);

export const humanFailureText = (
  presentation: HumanFailurePresentation,
): string => presentation.recovery === undefined
  ? presentation.summary
  : `${presentation.summary} ${presentation.recovery}`;
