"use client";

import { useSyncExternalStore } from "react";
import type { ComponentType } from "react";
import { Overlay } from "@sp/ui";
import { LimitationsGuide } from "./LimitationsGuide";
import { PaddingRulesGuide } from "./PaddingRulesGuide";

export type GuideId = "padding-rules" | "limitations";

interface GuideMeta {
  id: GuideId;
  title: string;
  subtitle: string;
  Body: ComponentType;
}

/** Guides readable in an overlay from anywhere, without leaving the current page. */
export const GUIDES: readonly GuideMeta[] = [
  {
    id: "padding-rules",
    title: "Padding rules explained",
    subtitle: "Alignment, padding and how compilers lay out structs.",
    Body: PaddingRulesGuide,
  },
  {
    id: "limitations",
    title: "Limitations",
    subtitle: "What the calculator models, approximates, and does not handle.",
    Body: LimitationsGuide,
  },
];

// ------------------------------------------------------------------ app-wide open state
// A tiny external store rather than React context: the header (root layout) and the sidebar
// (workbench) both open guides, and neither has to be wrapped in a provider for it.

let current: GuideId | null = null;
const listeners = new Set<() => void>();

function emit(next: GuideId | null) {
  current = next;
  for (const l of listeners) l();
}

export function openGuide(id: GuideId): void {
  emit(id);
}

export function closeGuide(): void {
  emit(null);
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function useOpenGuide(): GuideId | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}

/** Mounted once in the root layout; renders whichever guide is open. */
export function GuideOverlayHost() {
  const guideId = useOpenGuide();
  const guide = GUIDES.find((g) => g.id === guideId);
  return (
    <Overlay
      open={guide !== undefined}
      onClose={closeGuide}
      title={guide?.title ?? ""}
      subtitle={guide?.subtitle}
    >
      {guide && <guide.Body />}
    </Overlay>
  );
}
