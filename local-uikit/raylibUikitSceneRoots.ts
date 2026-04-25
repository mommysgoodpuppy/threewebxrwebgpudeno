import type { Object3D } from "three";
import type { RootContext } from "./context.ts";
import { Component } from "./components/component.ts";

/**
 * Deduplicated uikit {@link RootContext} for every uikit tree under `root`.
 * Raylib should read panel buffers from each context’s `panelGroupManager` — the same
 * `InstancedPanelGroup` / `InstancedPanelMesh` chain the WebGPU path uses — not by
 * pattern-matching the scene graph.
 */
export function collectUikitRootContextsFromObject(root: Object3D): Set<RootContext> {
  const out = new Set<RootContext>();
  root.traverseVisible((object) => {
    if (object instanceof Component) {
      out.add(object.root.value);
    }
  });
  return out;
}
