import {
  useEffect,
  useRef,
  useState,
} from "react";

import { Icon } from "./icons.js";

export type ClipboardTextWriter = (value: string) => Promise<void>;

export const writeClipboardText = async (
  value: string,
  writer: ClipboardTextWriter,
): Promise<void> => {
  await writer(value);
};

export const CopyableIdentifier = ({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) => {
  type CopyState = Readonly<{
    value: string;
    status: "idle" | "copying" | "copied" | "failed";
  }>;
  const [copyState, setCopyState] = useState<CopyState>({
    value,
    status: "idle",
  });
  const generationRef = useRef(0);
  const renderedValueRef = useRef(value);
  const activeGenerationRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(true);
  if (renderedValueRef.current !== value) {
    renderedValueRef.current = value;
    generationRef.current += 1;
    activeGenerationRef.current = undefined;
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      activeGenerationRef.current = undefined;
    };
  }, []);

  const status = copyState.value === value ? copyState.status : "idle";

  const copy = async (): Promise<void> => {
    if (activeGenerationRef.current !== undefined) return;
    const generation = ++generationRef.current;
    const boundValue = value;
    activeGenerationRef.current = generation;
    setCopyState({ value: boundValue, status: "copying" });
    try {
      await writeClipboardText(
        boundValue,
        (text) => navigator.clipboard.writeText(text),
      );
      if (
        mountedRef.current &&
        activeGenerationRef.current === generation &&
        renderedValueRef.current === boundValue
      ) {
        activeGenerationRef.current = undefined;
        setCopyState({ value: boundValue, status: "copied" });
      }
    } catch {
      if (
        mountedRef.current &&
        activeGenerationRef.current === generation &&
        renderedValueRef.current === boundValue
      ) {
        activeGenerationRef.current = undefined;
        setCopyState({ value: boundValue, status: "failed" });
      }
    }
  };

  return (
    <span className="copyable-identifier">
      <span className="copyable-identifier-control">
        <code className="copyable-identifier-value" title={value}>{value}</code>
        <button
          type="button"
          className="copy-identifier secondary icon-button"
          aria-label={`Copy ${label}`}
          title={`Copy ${label}`}
          disabled={status === "copying"}
          onClick={() => { void copy(); }}
        >
          <Icon name="copy" />
        </button>
      </span>
      {status === "idle" || status === "copying" ? null : (
        <span className={status === "failed" ? "copy-status copy-status-failed" : "copy-status"} role="status">
          {status === "copied" ? "Copied." : "Copy failed. Select and copy the complete value manually."}
        </span>
      )}
    </span>
  );
};
