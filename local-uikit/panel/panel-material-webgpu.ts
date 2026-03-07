import { FrontSide, Material, MeshBasicMaterial, MeshBasicNodeMaterial } from 'three'
import * as TSL from 'three/tsl'
import { MaterialClass } from '../../submodules/uikit/packages/uikit/src/panel/panel-material.ts'

function unpackBorderRadius(packedRadius: TSL.NodeRepresentation, height: TSL.NodeRepresentation) {
  return TSL.vec4(
    TSL.floor(packedRadius.div(125000)).mod(50),
    TSL.floor(packedRadius.div(2500)).mod(50),
    TSL.floor(packedRadius.div(50)).mod(50),
    TSL.mod(packedRadius, 50),
  ).mul(0.01).mul(height)
}

function createRoundedRectSdf(localUv: TSL.NodeRepresentation, halfSize: TSL.NodeRepresentation, radius: TSL.NodeRepresentation) {
  const corner = halfSize.sub(TSL.vec2(radius))
  const q = TSL.abs(localUv).sub(corner)
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
