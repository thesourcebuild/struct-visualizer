"use client";

import { Component } from "react";
import type { ReactNode } from "react";

/** Shows why a tool could not load (a failed chunk download, say) instead of a blank page. */
export class ToolErrorBoundary extends Component<{ children: ReactNode }, { error?: string }> {
  state: { error?: string } = {};

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  render() {
    if (this.state.error !== undefined) {
      return (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          Failed to load tool: {this.state.error}
        </p>
      );
    }
    return this.props.children;
  }
}
