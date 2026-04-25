/**
 * {@link InstancedPanelMesh} is only built in `InstancedPanelGroup.resize()`. Raythree’s generic
 * mesh lowerer must never treat it as a solid `Mesh` — that duplicate pass is what shows as the
 * flat white layer under the Raylib uikit shader. Registration is by **object identity** (not
 * `userData`). The set lives on `globalThis` so multiple copies of this module (different
 * resolution paths in the same Deno graph) still share one registry.
 */
const PANEL_MESH_SET_KEY = Symbol.for("@petplay/raylibUikitPanelMeshLowererRegistry");

function getPanelMeshSet(): WeakSet<object> {
  const g = globalThis as typeof globalThis & { [PANEL_MESH_SET_KEY]?: WeakSet<object> };
  let s = g[PANEL_MESH_SET_KEY];
  if (s == null) {
    s = new WeakSet();
    g[PANEL_MESH_SET_KEY] = s;
  }
  return s;
}

export function registerInstancedPanelMeshForRaythreeMeshLowerer(mesh: object): void {
  getPanelMeshSet().add(mesh);
}

export function unregisterInstancedPanelMeshForRaythreeMeshLowerer(mesh: object): void {
  getPanelMeshSet().delete(mesh);
}

export function isInstancedPanelMeshRegisteredForRaythreeMeshLowerer(mesh: object): boolean {
  return getPanelMeshSet().has(mesh);
}
