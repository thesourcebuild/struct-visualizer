"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "./Button";
import type { ButtonProps } from "./Button";

export interface CopyButtonProps extends Omit<ButtonProps, "onClick" | "value"> {
  /** Text to copy, or a function producing it at click time. */
  value: string | (() => string);
  label?: string;
}

export function CopyButton({ value, label = "Copy", ...rest }: CopyButtonProps) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(typeof value === "function" ? value() : value);
      setState("copied");
    } catch {
      setState("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  };

  return (
    <Button onClick={copy} aria-live="polite" {...rest}>
      {state === "copied" ? "Copied ✓" : state === "failed" ? "Copy failed" : label}
    </Button>
  );
}
