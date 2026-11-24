import {
  DynamicDrawUsage,
  FrontSide,
  InstancedBufferAttribute,
  Material,
  MeshBasicMaterial,
  MeshBasicNodeMaterial,
  Object3D,
} from 'three/webgpu'
import * as TSL from 'three/tsl'
import type { MaterialClass } from '../../submodules/uikit/packages/uikit/src/panel/material/create.ts'
import { InstancedPanelMesh } from '../../submodules/uikit/packages/uikit/src/panel/instance/mesh.ts'

// deno-lint-ignore no-explicit-any
function unpackBorderRadius(packedRadius: any, height: any) {
  return TSL.vec4(
    TSL.floor(packedRadius.div(125000)).mod(50),
    TSL.floor(packedRadius.div(2500)).mod(50),
    TSL.floor(packedRadius.div(50)).mod(50),
    TSL.mod(packedRadius, 50),
  ).mul(0.01).mul(height)
}

// deno-lint-ignore no-explicit-any
function createRoundedRectSdf(localUv: any, halfSize: any, radius: any) {
  const corner = halfSize.sub(TSL.vec2(radius))
  // deno-lint-ignore no-explicit-any
  const q: any = TSL.abs(localUv).sub(corner)
  return q.max(TSL.vec2(0)).length().add(q.x.max(q.y).min(0)).sub(radius)
}

export function canUseWebgpuPanelMaterial(MaterialCtor: MaterialClass) {
  return typeof MeshBasicNodeMaterial === 'function' && MaterialCtor === MeshBasicMaterial
}

export function createWebgpuPanelMaterial(_MaterialClass: MaterialClass): Material {
  const data0 = TSL.attribute('aData0', 'vec4')
  const data1 = TSL.attribute('aData1', 'vec4')
  const data2 = TSL.attribute('aData2', 'vec4')
  const data3 = TSL.attribute('aData3', 'vec4')

  const dimensions = TSL.vec2(data3.z.max(0.0001), data3.w.max(0.0001)).toVar('dimensions')
  const halfSize = dimensions.mul(0.5).toVar('halfSize')
  const borderSize = data0.toVar('borderSize')
  const backgroundColor = data1.xyz.toVar('backgroundColor')
  const backgroundOpacity = data1.w.toVar('backgroundOpacity')
  const borderColor = data2.yzw.toVar('borderColor')
  const borderOpacity = data3.x.toVar('borderOpacity')
  const borderWidth = borderSize.x.max(borderSize.y).max(borderSize.z).max(borderSize.w).toVar('borderWidth')
  const radius = unpackBorderRadius(data2.x, dimensions.y).toVar('radius')

  const localUv = TSL.positionGeometry.xy.mul(dimensions).toVar('localUv')
  const uniformRadius = radius.x.max(radius.y).max(radius.z).max(radius.w).min(halfSize.x).min(halfSize.y).toVar('uniformRadius')
  const outerSdf = createRoundedRectSdf(localUv, halfSize, uniformRadius).toVar('outerSdf')
  const outerAa = TSL.fwidth(outerSdf).max(0.0005)
  const outerAlpha = TSL.smoothstep(outerAa.negate(), outerAa, outerSdf).oneMinus().toVar('outerAlpha')

  const innerHalfSize = halfSize.sub(TSL.vec2(borderWidth)).max(TSL.vec2(0.0001)).toVar('innerHalfSize')
  const innerRadius = uniformRadius.sub(borderWidth).max(0).toVar('innerRadius')
  const innerSdf = createRoundedRectSdf(localUv, innerHalfSize, innerRadius).toVar('innerSdf')
  const innerAa = TSL.fwidth(innerSdf).max(0.0005)
  const fillMask = TSL.smoothstep(innerAa.negate(), innerAa, innerSdf).oneMinus().toVar('fillMask')

  const panelColor = TSL.mix(borderColor, backgroundColor, fillMask)
  const panelOpacity = outerAlpha.mul(TSL.mix(borderOpacity.max(backgroundOpacity), backgroundOpacity, fillMask))

  const material = new MeshBasicNodeMaterial({
    transparent: true,
    side: FrontSide,
    depthWrite: false,
    toneMapped: false,
  })

  material.colorNode = TSL.vec4(panelColor, panelOpacity)
  material.alphaToCoverage = true
  material.alphaTest = 0.001

  return material
}

type WebgpuPanelSyncState = {
  dataAttr: InstancedBufferAttribute
  version: number
  attrs: [
    InstancedBufferAttribute,
    InstancedBufferAttribute,
    InstancedBufferAttribute,
    InstancedBufferAttribute,
  ]
}

const webgpuPanelSync = new WeakMap<InstancedPanelMesh, WebgpuPanelSyncState>()

/**
 * WebGPU fallback for upstream `@pmndrs/uikit` `InstancedPanelMesh`: swaps WebGL `onBeforeCompile`
 * `MeshBasicMaterial` to the TSL `MeshBasicNodeMaterial` and mirrors the 16-float `aData` buffer
 * into four `vec4` attributes (`aData0..aData3`) when `aData.version` changes.
 */
export function syncWebgpuPanelFallback(rootComponent: Object3D): void {
  const children = rootComponent.children
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (!(child instanceof InstancedPanelMesh)) continue

    const mat = child.material as (Material & { isMeshBasicNodeMaterial?: boolean }) | undefined
    if (mat != null && !mat.isMeshBasicNodeMaterial && mat.type === 'MeshBasicMaterial' && canUseWebgpuPanelMaterial(MeshBasicMaterial)) {
      const nodeMat = createWebgpuPanelMaterial(MeshBasicMaterial)
      nodeMat.depthTest = mat.depthTest
      nodeMat.depthWrite = mat.depthWrite
      child.material = nodeMat
    }

    const aData = child.geometry.attributes.aData as InstancedBufferAttribute | undefined
    if (aData == null) continue

    let state = webgpuPanelSync.get(child)
    const count = Math.floor(aData.array.length / 16)
    if (state == null || state.dataAttr !== aData) {
      const makeAttr = () => {
        const attr = new InstancedBufferAttribute(new Float32Array(count * 4), 4, false)
        attr.setUsage(DynamicDrawUsage)
        return attr
      }
      const attrs: WebgpuPanelSyncState['attrs'] = [makeAttr(), makeAttr(), makeAttr(), makeAttr()]
      child.geometry.attributes.aData0 = attrs[0]
      child.geometry.attributes.aData1 = attrs[1]
      child.geometry.attributes.aData2 = attrs[2]
      child.geometry.attributes.aData3 = attrs[3]
      state = { dataAttr: aData, version: -1, attrs }
      webgpuPanelSync.set(child, state)
    }

    if (state.version === aData.version) continue
    const src = aData.array
    const d0 = state.attrs[0].array as Float32Array
    const d1 = state.attrs[1].array as Float32Array
    const d2 = state.attrs[2].array as Float32Array
    const d3 = state.attrs[3].array as Float32Array
    for (let idx = 0; idx < count; idx++) {
      const s = idx * 16
      const d = idx * 4
      d0[d] = src[s]!
      d0[d + 1] = src[s + 1]!
      d0[d + 2] = src[s + 2]!
      d0[d + 3] = src[s + 3]!
      d1[d] = src[s + 4]!
      d1[d + 1] = src[s + 5]!
      d1[d + 2] = src[s + 6]!
      d1[d + 3] = src[s + 7]!
      d2[d] = src[s + 8]!
      d2[d + 1] = src[s + 9]!
      d2[d + 2] = src[s + 10]!
      d2[d + 3] = src[s + 11]!
      d3[d] = src[s + 12]!
      d3[d + 1] = src[s + 13]!
      d3[d + 2] = src[s + 14]!
      d3[d + 3] = src[s + 15]!
    }
    state.attrs[0].needsUpdate = true
    state.attrs[1].needsUpdate = true
    state.attrs[2].needsUpdate = true
    state.attrs[3].needsUpdate = true
    state.version = aData.version
  }
}
